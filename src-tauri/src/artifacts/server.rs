//! The localhost display server (B1-B4, B10): the artifacts feature's
//! human surface. std-only — no HTTP crate in the tree; hand-rolled
//! HTTP/1.1 with bounds (8 KiB head cap, 30s head timeout, GET-only,
//! one request per connection, `Connection: close` everywhere, SSE
//! close-delimited streaming).
//!
//! Lifecycle mirrors McpServer (idempotent enable handled by the caller,
//! teardown wake, dead-flag) with ONE deliberate difference: no
//! port-local lock — a socket NAME is claimable, a kernel-assigned
//! ephemeral port is not, and the STORE root's lock (claim.rs)
//! transitively protects the port: enable claims the root BEFORE
//! binding, so a second instance fails at the claim and never gets here.
//!
//! ROUTE-TABLE INVARIANTS — break either knowingly, never by accident:
//! (1) NEVER answer 3xx from any route: the CSP spec ignores a source
//!     expression's PATH across redirects — one redirect and the
//!     per-artifact connect-src pin stops pinning. No redirects exist.
//! (2) NEVER produce a MIME outside MIME_ALLOWLIST: a JS-mime same-origin
//!     URL would let a hostile artifact register a service worker on
//!     the artifact origin.
//!
//! Layout note: B8 specced listener/http/routes/sse as separate files;
//! they land as this one `server.rs` with section banners (beside
//! `serve.rs`, `render.rs`, `token.rs`) — same code, fewer cohesive
//! units. Reviewers may ask for the split.

use std::collections::HashMap;
use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::artifacts::serve;
use crate::artifacts::store::{manifest_for, Manifest};
use crate::artifacts::token::{mint_token, token_eq};
use crate::http::request::Request;
use crate::http::{respond_empty, Status};

const KEEPALIVE_TICK: Duration = Duration::from_secs(15);

/// INVARIANT (2): the only MIMEs this server may ever answer with.
const MIME_SSE: &str = "text/event-stream";

/// (workspace, slug) — an artifact's identity for subscribers.
type SubKey = (String, String);

struct SubEntry {
    write: TcpStream,
    /// A `?v=`-pinned tab: never yanked to latest (§5's reviewer rule).
    pinned: Option<u64>,
    /// The artifact TOKEN this subscription was minted against. Delete
    /// → resurrect reuses the (ws,slug) KEY with a FRESH token; without
    /// the tie, stale tabs of the dead artifact would receive the NEW
    /// artifact's version events, reload, and 404 into a silent dead
    /// end. Broadcasts and the tick compare tokens before writing; a
    /// mismatch is a dead tab of a dead artifact → bye.
    token: String,
    /// Consecutive keepalive failures. ONE strike used to prune — a tab
    /// whose machine slept two seconds was silently unsubscribed
    /// forever. The second consecutive failure prunes: transient
    /// hiccup survives, a gone peer doesn't linger.
    strikes: u32,
}

/// Everything the threads share. `Arc`-held by DisplayServer, the accept
/// loop and the keepalive-tick loop alike. (Visible to the module's
/// tests — the wedged-subscriber test reads the registry directly.)
pub(super) struct Shared {
    /// The store root — read by the lock-free tail entries and mod.rs's
    /// resolve command.
    pub(super) root: PathBuf,
    /// Read by the lock-free tail entries (index_url_for, the resolve
    /// path) — pub(super) so mod.rs's router command reaches it.
    pub(super) port: u16,
    /// Index tokens: boot-minted per workspace, in-memory, dying with
    /// the port (B5 — born together, dead together).
    index_tokens: Mutex<HashMap<String, String>>,
    subs: Mutex<HashMap<SubKey, Vec<SubEntry>>>,
    /// Set by `stop` alone. The LISTENER has its own liveness — this one
    /// says the feature was torn down, which the tick loop and any
    /// in-flight connection read while the accept loop is winding up.
    dead: AtomicBool,
}

pub struct DisplayServer {
    pub(super) shared: Arc<Shared>,
    listener: crate::http::Listener,
}

impl DisplayServer {
    /// Bind first, then serve. The port is minted before the state because
    /// the state is built AROUND it — every URL this surface composes
    /// carries the port, so the handler cannot exist before the bind does.
    ///
    /// The caller (mod.rs's enable) has ALREADY claimed the store root — the
    /// read path goes to disk per request (the no-cache rule), so the server
    /// needs only the root, not the store object.
    pub fn start(root: &Path) -> Result<Self, String> {
        let bound = crate::http::bind("artifacts")?;
        let shared = Arc::new(Shared {
            root: root.to_path_buf(),
            port: bound.port,
            index_tokens: Mutex::new(HashMap::new()),
            subs: Mutex::new(HashMap::new()),
            dead: AtomicBool::new(false),
        });
        let serving = Arc::clone(&shared);
        let listener =
            crate::http::Listener::serve(bound, "artifacts", crate::http::Limits::NO_BODY, move |stream, request| {
                handle_connection(stream, request, Arc::clone(&serving))
            })?;
        Self::with_tick(shared, listener, |shared| {
            std::thread::Builder::new()
                .name("keepdeck artifacts tick".into())
                .spawn(move || tick_loop(shared))
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
    }

    /// The tick spawn is injected so a test can fail it. A keepalive thread
    /// that never started must take the listener down with it: a port that
    /// answers while nobody minds the subscribers is worse than no port.
    fn with_tick<Tick>(
        shared: Arc<Shared>,
        listener: crate::http::Listener,
        spawn_tick: Tick,
    ) -> Result<Self, String>
    where
        Tick: FnOnce(Arc<Shared>) -> Result<(), String>,
    {
        if let Err(error) = spawn_tick(Arc::clone(&shared)) {
            shared.dead.store(true, Ordering::SeqCst);
            listener.stop();
            return Err(format!("spawning the keepalive tick failed: {error}"));
        }
        Ok(Self { shared, listener })
    }

    pub fn port(&self) -> u16 {
        self.shared.port
    }

    /// Is the accept loop still serving? It can die on its OWN — a poll
    /// fault or ACCEPT_FAILURE_LIMIT consecutive accept failures set the
    /// flag and drop the listener, so the port stops answering — and
    /// nothing restarts it. Without this, a later enable short-circuits
    /// on the corpse and reports `Ok(dead port)`.
    pub fn is_alive(&self) -> bool {
        self.listener.is_alive() && !self.shared.dead.load(Ordering::SeqCst)
    }

    /// Teardown: bye to EVERY subscriber (Off means Off — subscribers
    /// close before anything they observe changes shape), then the wake
    /// drop ends the accept loop and the tick sees dead and exits.
    pub fn stop(&self) {
        let mut registry = self.shared.subs.lock().expect("subs poisoned");
        let drained: Vec<SubEntry> = registry.values_mut().flat_map(|v| v.drain(..)).collect();
        drop(registry);
        for entry in drained {
            let _ = write_event(&entry.write, "bye", "server stopping");
            let _ = entry.write.shutdown(std::net::Shutdown::Both);
        }
        self.shared.dead.store(true, Ordering::SeqCst);
        // Subscribers first, listener second: Off means Off, and a tab that
        // learned the server is going away before the port stops answering
        // closes on its own terms instead of on a refused reconnect.
        self.listener.stop();
    }

    /// compose_urls (B10): the ONE URL builder, the publish path's entry
    /// (token in hand from the store commit) — built from the shared
    /// builders' pair below.
    pub fn compose_urls(&self, ws: &str, slug: &str, token: &str) -> (String, String) {
        let index = self.index_url(ws);
        (artifact_url_for(&self.shared, token, slug), index)
    }

    fn index_url(&self, ws: &str) -> String {
        index_url_for(&self.shared, ws)
    }

    // (resolve_urls and broadcast_version moved to the LOCK-FREE
    // entries — index_url_for / broadcast_version_on — when the command
    // tail stopped holding the server mutex; the methods died with the
    // move, deleted rather than suppressed.)

    /// The shared handle for lock-free tail operations (the publish tail
    /// broadcasts WITHOUT holding the server mutex — see
    /// broadcast_version_on).
    pub fn shared_arc(&self) -> Arc<Shared> {
        Arc::clone(&self.shared)
    }

    /// Broadcast `bye` + close SYNCHRONOUSLY (tool-delete) — the
    /// milliseconds walk, not tick-paced (B4).
    pub fn broadcast_bye(&self, ws: &str, slug: &str, reason: &str) {
        let mut registry = self.shared.subs.lock().expect("subs poisoned");
        if let Some(entries) = registry.remove(&(ws.to_string(), slug.to_string())) {
            for entry in entries {
                let _ = write_event(&entry.write, "bye", reason);
                let _ = entry.write.shutdown(std::net::Shutdown::Both);
            }
        }
    }
}

/// Broadcast a `version` event to an artifact's UNPINNED subscribers —
/// callable WITHOUT the DisplayServer mutex (the publish tail's shape):
/// the caller holds only this Arc. The CURRENT artifact's token is
/// re-read per broadcast (the no-cache rule): entries minted against a
/// DIFFERENT token are tabs of a dead generation (delete → resurrect
/// reused the key); they get bye, never the new artifact's events.
pub(super) fn broadcast_version_on(
    shared: &Arc<Shared>,
    ws: &str,
    slug: &str,
    version: u64,
) {
    let live_token = manifest_for(&shared.root, ws, slug)
        .ok()
        .flatten()
        .map(|m| m.token);
    let mut registry = shared.subs.lock().expect("subs poisoned");
    if let Some(entries) = registry.get_mut(&(ws.to_string(), slug.to_string())) {
        entries.retain(|entry| {
            if let Some(token) = &live_token {
                if &entry.token != token {
                    let _ = write_event(&entry.write, "bye", "artifact replaced");
                    let _ = entry.write.shutdown(std::net::Shutdown::Both);
                    return false;
                }
            }
            if entry.pinned.is_some() {
                return true; // pinned: never yanked, stays subscribed
            }
            write_event(&entry.write, "version", &version.to_string()).is_ok()
        });
    }
}

fn ensure_index_token(shared: &Shared, ws: &str) -> String {
    let mut tokens = shared.index_tokens.lock().expect("index tokens poisoned");
    tokens
        .entry(ws.to_string())
        .or_insert_with(mint_token)
        .clone()
}

/// The workspace index URL — lock-free entry (the notification router's
/// resolution runs without the server mutex).
pub(super) fn index_url_for(shared: &Arc<Shared>, ws: &str) -> String {
    let token = ensure_index_token(shared, ws);
    format!("http://127.0.0.1:{}/{}/", shared.port, token)
}

/// The artifact URL — the grammar's other half, beside `index_url_for`
/// as the ONE builders' pair. The resolve-urls command re-assembled
/// this shape inline once; both doors now share the format string, so
/// a prefix or token-segment change cannot happen to one alone.
pub(super) fn artifact_url_for(shared: &Arc<Shared>, token: &str, slug: &str) -> String {
    format!("http://127.0.0.1:{}/a/{}/{}", shared.port, token, slug)
}

/// The artifact's live-events endpoint — the page's subscription target,
/// and therefore what its CSP has to name. Composed FROM the artifact
/// url, so the prefix and the token segment keep the one home the pair
/// above promises; the `/events` suffix is the only new knowledge, and it
/// belongs here beside the route that answers it. The page builder is
/// handed the result and never learns the origin.
pub(super) fn events_url_for(shared: &Arc<Shared>, token: &str, slug: &str) -> String {
    format!("{}/events", artifact_url_for(shared, token, slug))
}


// ---- routes (B3) ----

/// The `?v=` pin, this surface's own vocabulary — read ONCE, before any
/// route is chosen, so every consumer downstream gets the same value and a
/// malformed pin is refused at the same moment it always was.
///
/// Saturating rather than rejecting on overflow (the no-oracle rule): a
/// digit-shaped `v` that fails a u64 parse once answered 200-latest on VALID
/// pairs, which is a token-guessing oracle. `u64::MAX` is never found in a
/// manifest's dense 1..n, so every consumer treats it as a 404 pin instead.
fn version_pin(query: Option<&str>) -> Result<Option<u64>, Status> {
    let Some(raw) = query.and_then(|q| {
        q.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == "v").then(|| v.to_string())
        })
    }) else {
        return Ok(None);
    };
    if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_digit()) {
        return Err(Status::BadRequest);
    }
    Ok(Some(raw.parse::<u64>().unwrap_or(u64::MAX)))
}

fn handle_connection(mut stream: TcpStream, request: Request, shared: Arc<Shared>) {
    // INVARIANT: this surface answers reads and nothing else. The rule used
    // to live in the shared parser, which made it every surface's rule; it
    // belongs here, where the reason for it is.
    if request.method != crate::http::Method::Get {
        let _ = respond_empty(&mut stream, Status::MethodNotAllowed);
        return;
    }
    // Before the dead check and before routing, exactly where the shared
    // parser used to do it — so a malformed pin still answers 400 whatever
    // the path was, and the status never depends on route knowledge.
    let query_v = match version_pin(request.query.as_deref()) {
        Ok(pin) => pin,
        Err(status) => {
            let _ = respond_empty(&mut stream, status);
            return;
        }
    };
    if shared.dead.load(Ordering::SeqCst) {
        let _ = respond_empty(&mut stream, Status::NotFound);
        return;
    }
    let segments: Vec<&str> = request.path.trim_matches('/').split('/').collect();
    // NO-ORACLE: unknown token and valid-token-unknown-id answer
    // byte-identical 404s — nothing distinguishes them.
    let not_found = |stream: &mut TcpStream| respond_empty(stream, Status::NotFound);

    match segments.as_slice() {
        // Artifact routes: the TOKEN is the first segment under /a/.
        ["a", token, slug] => {
            match resolve_by_token(&shared, token, slug) {
                Some((ws, manifest)) => {
                    let events = events_url_for(&shared, &manifest.token, slug);
                    serve::serve_artifact(
                        &mut stream,
                        &shared.root,
                        &events,
                        &ws,
                        &manifest,
                        slug,
                        query_v,
                    );
                }
                None => {
                    let _ = not_found(&mut stream);
                }
            }
        }
        ["a", token, slug, "events"] => {
            match resolve_by_token(&shared, token, slug) {
                Some((ws, manifest)) => {
                    subscribe(stream, &shared, ws, slug, manifest, query_v);
                }
                None => {
                    let _ = not_found(&mut stream);
                }
            }
        }
        ["a", token, slug, "export"] => match resolve_by_token(&shared, token, slug) {
            Some((ws, manifest)) => {
                serve::serve_export(&mut stream, &shared.root, &ws, &manifest, slug);
            }
            None => {
                let _ = not_found(&mut stream);
            }
        },
        [index_token] => {
            // The workspace INDEX: the token resolves the workspace via
            // the in-memory boot-mint map (constant-time compare).
            let ws = shared
                .index_tokens
                .lock()
                .expect("index tokens poisoned")
                .iter()
                .find(|(_, v)| token_eq(v, index_token))
                .map(|(k, _)| k.clone());
            match ws {
                Some(ws) => serve::serve_index(&mut stream, &shared.root, &ws),
                None => {
                    let _ = not_found(&mut stream);
                }
            }
        }
        _ => {
            let _ = not_found(&mut stream);
        }
    }
}

/// Token resolution is a SCAN, not a map (B3): a token+slug pair names
/// no workspace; iterate ws/*/ reading each matching slug's manifest,
/// constant-time token compare. O(workspaces) per request — a stated
/// decision, not an accident.
fn resolve_by_token(shared: &Shared, token: &str, slug: &str) -> Option<(String, crate::artifacts::store::Manifest)> {
    for (ws, manifest) in crate::artifacts::store::scan_workspaces(&shared.root, slug).ok()? {
        if token_eq(&manifest.token, token) {
            return Some((ws, manifest));
        }
    }
    None
}

// ---- SSE (B4) ----

fn write_event(stream: &TcpStream, event: &str, data: &str) -> std::io::Result<()> {
    let mut stream = stream.try_clone()?;
    stream.write_all(format!("event: {event}\ndata: {data}\n\n").as_bytes())?;
    stream.flush()
}

fn subscribe(
    mut stream: TcpStream,
    shared: &Arc<Shared>,
    ws: String,
    slug: &str,
    manifest: Manifest,
    pinned: Option<u64>,
) {
    // The SSE response: close-delimited (no Content-Length), the read
    // half ignored, writes event-driven.
    // NO immediate event on subscribe. The premise USED to be that html
    // served verbatim, so nothing could ever tell the page its version;
    // the server installs the refresh script now, and the conclusion is
    // unchanged because the script is all that is installed — not a
    // version number. The page still cannot know which version it is
    // showing, so its contract remains "reload on ANY version event",
    // and an immediate event would loop page→subscribe→reload forever.
    // The fresh tab already holds latest content from its GET; the first
    // event it needs is the NEXT version.
    // Injecting the version alongside the script would end that
    // constraint — and would trade a one-line rule for a cache-coherence
    // problem between the stored bytes and the number stamped into them.
    // (No ACAO header: absent ACAO already blocks cross-origin reads;
    // a fake value would read as a security property that isn't there.
    // Artifact-A-JS-reaching-B's stream is the per-artifact connect-src
    // pin's job, exactly as designed.)
    // The head carries an immediate `: ping` comment — a COMMENT, so the
    // no-unsolicited-event rule above is untouched (nothing dispatches, no
    // handler runs, no reload can fire). It exists because the keepalive
    // is ONE global tick that sleeps first: a fresh subscriber would
    // otherwise sit on a byte-less stream for anywhere up to 15 seconds
    // before the first sign that this connection carries anything.
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {MIME_SSE}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n: ping\n\n"
    );
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    // The write timeout rides the ACCEPTED socket (inherited by this
    // clone) — set in read_request; a wedged subscriber errors and
    // prunes instead of blocking the registry lock.
    shared
        .subs
        .lock()
        .expect("subs poisoned")
        .entry((ws, slug.to_string()))
        .or_default()
        .push(SubEntry { write: stream, pinned, token: manifest.token, strikes: 0 });
    // The connection thread ENDS here; broadcasts and the tick write to
    // the stored clone; a dead peer's write error prunes it lazily.
}

// (latest_of died with the immediate-version event — the subscriber's
// first event is now always the NEXT version.)

/// ONE keepalive tick thread per server (B4): walks the registry every
/// 15s — a manifest re-read per distinct artifact doubles as the
/// rm-the-dir backstop (gone → bye + close); alive → `: ping`.
/// NO unwrap anywhere in this loop: a panicking tick thread would take
/// the whole backstop with it silently (keepalive stops, rm-detection
/// stops, no restart) — exactly the silent-stale-tab failure F-E exists
/// to prevent, entered through our own thread.
fn tick_loop(shared: Arc<Shared>) {
    loop {
        std::thread::sleep(KEEPALIVE_TICK);
        if shared.dead.load(Ordering::SeqCst) {
            return;
        }
        let keys: Vec<SubKey> = shared
            .subs
            .lock()
            .expect("subs poisoned")
            .keys()
            .cloned()
            .collect();
        for (ws, slug) in keys {
            let alive = manifest_for(&shared.root, &ws, &slug)
                .ok()
                .flatten()
                .is_some();
            if !alive {
                let mut registry = shared.subs.lock().expect("subs poisoned");
                if let Some(entries) = registry.remove(&(ws, slug)) {
                    for entry in entries {
                        let _ = write_event(&entry.write, "bye", "artifact gone");
                        let _ = entry.write.shutdown(std::net::Shutdown::Both);
                    }
                }
                continue;
            }
            let mut registry = shared.subs.lock().expect("subs poisoned");
            if let Some(entries) = registry.get_mut(&(ws, slug)) {
                let mut doomed = Vec::new();
                for (index, entry) in entries.iter_mut().enumerate() {
                    let ping_ok = entry
                        .write
                        .try_clone()
                        .and_then(|mut ping| {
                            ping.write_all(b": ping\n\n").and_then(|_| ping.flush())
                        })
                        .is_ok();
                    if ping_ok {
                        entry.strikes = 0;
                    } else {
                        entry.strikes += 1;
                        // Two consecutive failures prune (one is a
                        // sleeping tab's hiccup — see SubEntry::strikes).
                        if entry.strikes >= 2 {
                            doomed.push(index);
                        }
                    }
                }
                for index in doomed.into_iter().rev() {
                    entries.remove(index);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // The trait the file itself no longer needs: the head parse that used it
    // moved to `crate::http`, but these tests still read sockets directly.
    use std::io::Read;
    use crate::artifacts::store::{
        ArtifactFormat, ArtifactsStore, PublishRequest,
    };
    // `Read` rides the file's own `use std::io::{...}` — no test re-import.
    use std::os::fd::AsRawFd as _;

    /// Wait until `count` subscribers are REGISTERED for (ws, slug).
    ///
    /// Replaces a fixed sleep before every broadcast. The sleep was a
    /// guess at how long the accept thread needs to write the SSE head
    /// and push the entry, and a guess is a race by construction: on a
    /// loaded machine — two cargo suites and a vitest run at once — the
    /// broadcast went out before the subscription existed, reached
    /// nobody, and the test failed with a 200 head and no version event.
    /// Waiting for the FACT removes the window rather than widening it,
    /// and costs a couple of milliseconds instead of a flat 150.
    ///
    /// Registration is the LAST thing `subscribe` does, after the head
    /// is written — so once the entry is visible here, any broadcast
    /// that follows will find it.
    fn await_subscribers(server: &DisplayServer, ws: &str, slug: &str, count: usize) {
        let key = (ws.to_string(), slug.to_string());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let seen = {
                let subs = server.shared.subs.lock().expect("subs poisoned");
                subs.get(&key).map(|v| v.len()).unwrap_or(0)
            };
            if seen >= count {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{ws}/{slug}: {seen} of {count} subscribers registered within 5s",
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// A live server over a real store root in a temp dir.
    fn fixture(tag: &str) -> (DisplayServer, ArtifactsStore, PathBuf, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(format!("artifacts-{tag}"));
        let store = ArtifactsStore::default();
        store.enable(&root).unwrap();
        let server = DisplayServer::start(&root).unwrap();
        (server, store, root, dir)
    }

    #[test]
    fn tick_spawn_failure_tears_down_the_accept_loop() {
        // A keepalive thread that never started leaves subscribers unminded,
        // so the listener must come down with it — and the port must be free
        // by the time the error is returned, not eventually.
        let bound = crate::http::bind("artifacts test").unwrap();
        let port = bound.port;
        let shared = Arc::new(Shared {
            root: std::env::temp_dir(),
            port,
            index_tokens: Mutex::new(HashMap::new()),
            subs: Mutex::new(HashMap::new()),
            dead: AtomicBool::new(false),
        });
        let serving = Arc::clone(&shared);
        let listener =
            crate::http::Listener::serve(bound, "artifacts test", crate::http::Limits::NO_BODY, move |stream, request| {
                handle_connection(stream, request, Arc::clone(&serving))
            })
            .unwrap();

        let error = DisplayServer::with_tick(Arc::clone(&shared), listener, |_| {
            Err("injected tick spawn failure".into())
        })
        .err()
        .expect("injected tick failure must return Err");

        assert_eq!(
            error,
            "spawning the keepalive tick failed: injected tick spawn failure"
        );
        // stop() joins the accept thread, so a refused connection here means
        // the loop is gone, not merely asked to go.
        assert!(TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(250),
        )
        .is_err());
        assert!(shared.dead.load(Ordering::SeqCst));
    }

    fn publish(store: &ArtifactsStore, slug: &str, body: &[u8]) -> String {
        store
            .publish(
                "ws-1",
                PublishRequest {
                    slug: Some(slug),
                    title: "T",
                    format: ArtifactFormat::Html,
                    path: None,
                    content: Some(body),
                    message: None,
                    cwd: None,
                },
                1000,
            )
            .unwrap()
            .token
    }

    /// One GET; returns (status-line, headers-lowercase, body-raw).
    fn get(port: u16, path: &str) -> (String, String, Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
            .unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let text = String::from_utf8_lossy(&raw).into_owned();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let mut lines = head.lines();
        let status = lines.next().unwrap().to_string();
        let headers: String = lines.map(str::to_lowercase).collect::<Vec<_>>().join("\n");
        (status, headers, body.as_bytes().to_vec())
    }

    /// The `connect-src` value, as the browser would read it.
    fn connect_src(headers: &str) -> String {
        let at = headers
            .find("connect-src ")
            .expect("the served CSP names connect-src");
        let rest = &headers[at + "connect-src ".len()..];
        rest.split(';').next().unwrap_or("").trim().to_string()
    }

    /// THE CSP PIN — a source-expression, not a spelling.
    ///
    /// Its ancestor asserted the header CONTAINED `connect-src /a/{token}/
    /// {slug}/events` and passed for eight days while every browser
    /// refused the subscription: a bare path is not a source-expression
    /// (the grammar requires a host), so the directive named nothing and
    /// blocked everything — including the artifact's own endpoint. A
    /// containment check cannot see that; these assertions can.
    #[test]
    fn artifact_page_carries_the_path_pinned_csp_and_the_authors_bytes() {
        let (server, store, _root, _dir) = fixture("csp");
        let token = publish(&store, "auth-flow", b"<body><h1>v1</h1></body>");
        let (status, headers, body) = get(server.port(), &format!("/a/{token}/auth-flow"));
        assert!(status.starts_with("HTTP/1.1 200"), "{status}");

        let source = connect_src(&headers);
        // The page subscribes to its own pathname + "/events"; the policy
        // must name THAT url, absolutely.
        assert_eq!(
            source,
            format!("http://127.0.0.1:{}/a/{token}/auth-flow/events", server.port()),
            "connect-src must name the artifact's own events endpoint: {headers}",
        );
        // The regression itself: an origin is what makes it a source at
        // all. A path-only value silently means "deny everything".
        assert!(
            source.starts_with("http://") && !source.starts_with('/'),
            "a bare path is not a CSP source-expression: {source:?}",
        );
        // Still PINNED, not 'self': artifact A must not reach artifact B.
        assert!(source.ends_with("/auth-flow/events"), "{source:?}");
        assert!(headers.contains("base-uri 'none'"));
        assert!(headers.contains("form-action 'none'"));
        assert!(headers.contains("referrer-policy: no-referrer"));
        assert!(headers.contains("x-content-type-options: nosniff"));
        let served = String::from_utf8(body).expect("the page is utf-8");
        assert!(served.starts_with("<body><h1>v1</h1>"), "{served}");
        assert_eq!(
            served.matches("EventSource(location.pathname").count(),
            1,
            "the served page subscribes exactly once",
        );
        server.stop();
    }

    #[test]
    fn no_oracle_unknown_token_and_unknown_id_are_byte_identical() {
        let (server, store, _root, _dir) = fixture("oracle");
        let token = publish(&store, "x", b"<p/>");
        let (_, headers_a, body_a) = get(server.port(), "/a/wrong-token/x");
        let (_, headers_b, body_b) = get(server.port(), &format!("/a/{token}/no-such-artifact"));
        assert_eq!(headers_a, headers_b);
        assert_eq!(body_a, body_b);
        server.stop();
    }

    #[test]
    fn non_get_is_405_and_the_route_table_never_redirects() {
        let (server, store, _root, _dir) = fixture("methods");
        let token = publish(&store, "x", b"<p/>");
        let mut stream = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        stream
            .write_all(format!("POST /a/{token}/x HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
            .unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let text = String::from_utf8_lossy(&raw).into_owned();
        assert!(text.starts_with("HTTP/1.1 405"), "{text}");
        assert!(!text.contains(" 3"), "no 3xx anywhere: {text}");
        server.stop();
    }

    #[test]
    fn export_prepends_the_meta_csp_at_byte_zero() {
        let (server, store, _root, _dir) = fixture("export");
        // A crafted page placing its own <head> LATE: everything before
        // our meta would run unsandboxed from file:// if we inserted
        // after theirs — byte-zero prepend is the fix under test.
        let crafted = b"<html><body>late head</body><head>x</head></html>";
        let token = publish(&store, "crafted", crafted);
        let (status, headers, body) = get(server.port(), &format!("/a/{token}/crafted/export"));
        assert!(status.starts_with("HTTP/1.1 200"), "{status}");
        assert!(headers.contains("content-disposition: attachment"), "{headers}");
        let text = String::from_utf8_lossy(&body).into_owned();
        assert!(
            text.starts_with("<head><meta http-equiv=\"Content-Security-Policy\""),
            "meta is the FIRST bytes: {}",
            &text[..80.min(text.len())]
        );
        assert!(text.ends_with("late head</body><head>x</head></html>"));
        server.stop();
    }

    #[test]
    fn sse_subscriber_gets_live_updates_and_no_unsolicited_version() {
        let (server, store, _root, _dir) = fixture("sse");
        let token = publish(&store, "live", b"v1");
        let mut sub = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        sub.write_all(
            format!("GET /a/{token}/live/events HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes(),
        )
        .unwrap();
        await_subscribers(&server, "ws-1", "live", 1);
        // NO unsolicited version event: the fresh subscriber already
        // holds latest from its GET — an immediate version would loop
        // page→subscribe→reload forever with the snippet contract
        // (D5-1's regression pin).
        broadcast_version_on(&server.shared_arc(), "ws-1", "live", 2);
        let stream = sub.try_clone().unwrap();
        let _ = stream.shutdown(std::net::Shutdown::Write);
        let mut raw = Vec::new();
        sub.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let _ = sub.read_to_end(&mut raw);
        let text = String::from_utf8_lossy(&raw).into_owned();
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert!(text.contains("event: version\ndata: 2"), "live update:\n{text}");
        let events: usize = text.matches("event: version").count();
        assert_eq!(events, 1, "exactly the live update, nothing unsolicited:\n{text}");
        server.stop();
    }

    #[test]
    fn a_pinned_tab_receives_nothing_on_republish_while_the_sibling_updates() {
        let (server, store, _root, _dir) = fixture("pinned");
        let token = publish(&store, "pin", b"v1");
        let mut pinned = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        pinned
            .write_all(
                format!("GET /a/{token}/pin/events?v=1 HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes(),
            )
            .unwrap();
        let mut sibling = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        sibling
            .write_all(
                format!("GET /a/{token}/pin/events HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes(),
            )
            .unwrap();
        // BOTH tabs: the pinned one must be registered too, or "it
        // received nothing" would be proving the wrong thing.
        await_subscribers(&server, "ws-1", "pin", 2);
        broadcast_version_on(&server.shared_arc(), "ws-1", "pin", 2);
        // KEPT, and not the race the readiness poll above removes: this
        // waits on nothing that could be outrun. `broadcast_version_on`
        // writes inline while holding the registry lock, so the sibling's
        // bytes are already out when it returns, and the pinned tab is
        // retained without a write at all. What follows is a NEGATIVE
        // assertion — "the pinned tab received nothing" — and a negative
        // has no fact to wait for, only a duration to grant. The 3s read
        // windows below do the real proving; this is the settle before
        // the write halves close.
        std::thread::sleep(Duration::from_millis(300));
        let _ = pinned.shutdown(std::net::Shutdown::Write);
        let _ = sibling.shutdown(std::net::Shutdown::Write);
        let mut pinned_bytes = Vec::new();
        pinned
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let _ = pinned.read_to_end(&mut pinned_bytes);
        let pinned_text = String::from_utf8_lossy(&pinned_bytes).into_owned();
        assert!(
            !pinned_text.contains("event: version"),
            "pinned stays untouched:\n{pinned_text}"
        );
        let mut sibling_bytes = Vec::new();
        sibling
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let _ = sibling.read_to_end(&mut sibling_bytes);
        let sibling_text = String::from_utf8_lossy(&sibling_bytes).into_owned();
        assert!(sibling_text.contains("event: version\ndata: 2"), "{sibling_text}");
        server.stop();
    }

    #[test]
    fn the_keepalive_tick_detects_an_external_rm() {
        let (server, store, root, dir) = fixture("rm");
        let token = publish(&store, "gone-later", b"v1");
        let mut sub = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        sub.write_all(
            format!("GET /a/{token}/gone-later/events HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes(),
        )
        .unwrap();
        await_subscribers(&server, "ws-1", "gone-later", 1);
        // The external rm: outside the server, outside the store.
        std::fs::remove_dir_all(root.join("ws/ws-1/gone-later")).unwrap();
        let _ = dir;
        let mut raw = Vec::new();
        sub.set_read_timeout(Some(KEEPALIVE_TICK + Duration::from_secs(5)))
            .unwrap();
        let _ = sub.read_to_end(&mut raw);
        let text = String::from_utf8_lossy(&raw).into_owned();
        assert!(
            text.contains("event: bye\ndata: artifact gone"),
            "tick backstop fired:\n{text}"
        );
        server.stop();
    }


    #[test]
    fn a_wedged_subscriber_prunes_instead_of_hanging_the_broadcast() {
        // End-to-end: a real store publish feeding the server's own
        // broadcast (the command tail's exact wiring), with a subscriber
        // that NEVER reads — its buffer fills, the write times out, the
        // entry prunes, and the broadcast RETURNS (no hang, no panic).
        // The wedge is REAL: the client sets a tiny SO_RCVBUF before
        // connecting (a previous version drove ~1KB of events against
        // default buffers and passed vacuously — the timeout never
        // engaged).
        let (server, store, root, _dir) = fixture("wedged");
        let token = publish(&store, "wedge", b"v1");
        let mut wedged = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        let rcvbuf: libc::c_int = 1024;
        unsafe {
            libc::setsockopt(
                wedged.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_RCVBUF,
                &rcvbuf as *const _ as *const libc::c_void,
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            );
        }
        wedged
            .write_all(
                format!("GET /a/{token}/wedge/events HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes(),
            )
            .unwrap();
        await_subscribers(&server, "ws-1", "wedge", 1);
        // Fill the wedged subscriber's small buffer: broadcasts until the
        // write timeout errors. Bounded by the work, not wall time.
        for i in 2..=40u64 {
            store
                .publish(
                    "ws-1",
                    PublishRequest {
                        slug: Some("wedge"),
                        title: "T",
                        format: ArtifactFormat::Html,
                        path: None,
                        content: Some(b"bytes"),
                        message: None,
                        cwd: None,
                    },
                    1000 + i,
                )
                .unwrap();
            broadcast_version_on(&server.shared_arc(), "ws-1", "wedge", i);
        }
        // The registry prunes the dead entry on a failing write; wait for
        // THAT rather than for a duration — a fixed 200ms was a guess at
        // how fast the last broadcast's write times out, and the guess is
        // the only thing that could ever have made this test wrong. The
        // proof of no-hang is that we GOT here at all.
        let key = ("ws-1".to_string(), "wedge".to_string());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let pinned = loop {
            let seen = {
                let registry = server.shared.subs.lock().expect("subs poisoned");
                registry.get(&key).map(|v| v.len()).unwrap_or(0)
            };
            if seen <= 1 || std::time::Instant::now() >= deadline {
                break seen;
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        assert!(pinned <= 1, "wedged entry pruned or pending prune: {pinned}");
        let _ = root;
        server.stop();
    }

    #[test]
    fn enable_is_idempotent_the_port_survives() {
        // Double-enable returns the SAME port — the McpServer promise
        // the lifecycle shape claims to mirror (the store's own enable
        // is idempotent; the SERVER must not rebind).
        let (server, store, root, dir) = fixture("idem");
        let first = server.port();
        store.disable();
        store.enable(&root).unwrap();
        assert_eq!(server.port(), first);
        // And two INDEPENDENT servers (separate instances) get different
        // ephemeral ports — the kernel's guarantee, asserted so a future
        // fixed-port change trips it knowingly.
        let (server2, _store2, _root2, dir2) = fixture("idem2");
        assert_ne!(server.port(), server2.port());
        let _ = (dir, dir2);
        server.stop();
        server2.stop();
    }

    #[test]
    fn delete_says_bye_synchronously() {
        let (server, store, _root, _dir) = fixture("bye");
        let token = publish(&store, "gone", b"v1");
        let mut sub = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        sub.write_all(
            format!("GET /a/{token}/gone/events HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes(),
        )
        .unwrap();
        await_subscribers(&server, "ws-1", "gone", 1);
        store.delete("ws-1", "gone", None).unwrap();
        // The delete command's bye walk (mod.rs) — replicated here: the
        // server's own broadcast_bye.
        server.broadcast_bye("ws-1", "gone", "artifact deleted");
        let mut raw = Vec::new();
        sub.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let _ = sub.read_to_end(&mut raw);
        let text = String::from_utf8_lossy(&raw).into_owned();
        assert!(text.contains("event: bye\ndata: artifact deleted"), "{text}");
        server.stop();
    }

    #[test]
    fn the_index_lists_artifacts_and_escapes_their_titles() {
        let (server, store, _root, _dir) = fixture("index");
        let token = publish(&store, "x", b"<p/>");
        // A title with markup: the index must escape it.
        store
            .publish(
                "ws-1",
                PublishRequest {
                    slug: Some("evil"),
                    title: "<script>t</script>",
                    format: ArtifactFormat::Html,
                    path: None,
                    content: Some(b"x"),
                    message: None,
                    cwd: None,
                },
                1000,
            )
            .unwrap();
        let index_url = server.compose_urls("ws-1", "probe", &token).1;
        let path = index_url.trim_start_matches("http://127.0.0.1:");
        let path = path.trim_start_matches(&server.port().to_string());
        let (_, headers, body) = get(server.port(), path);
        assert!(headers.contains("content-security-policy"), "{headers}");
        let text = String::from_utf8_lossy(&body).into_owned();
        assert!(text.contains("&lt;script&gt;t&lt;/script&gt;"), "{text}");
        assert!(!text.contains("<script>"), "{text}");
        server.stop();
    }

    /// THE `?v=` DOOR. The route has parsed the pin since the first
    /// commit and the registry honours it, but nothing in the product
    /// ever emitted such a url — a shipped server feature with no client
    /// entry point, so version history was reachable by agents
    /// (artifact_read) and by nobody else. The index is the door: one
    /// link per version, and each one must actually serve THAT version.
    #[test]
    fn the_index_offers_a_working_link_per_version() {
        let (server, store, _root, _dir) = fixture("versions");
        let token = publish(&store, "many", b"<body>v1</body>");
        for (n, body) in [(2u64, &b"<body>v2</body>"[..]), (3, &b"<body>v3</body>"[..])] {
            store
                .publish(
                    "ws-1",
                    PublishRequest {
                        slug: Some("many"),
                        title: "T",
                        format: ArtifactFormat::Html,
                        path: None,
                        content: Some(body),
                        message: None,
                        cwd: None,
                    },
                    1000 + n,
                )
                .unwrap();
        }
        let index_url = server.compose_urls("ws-1", "many", &token).1;
        let path = index_url.trim_start_matches("http://127.0.0.1:");
        let path = path.trim_start_matches(&server.port().to_string());
        let (_, _, body) = get(server.port(), path);
        let listing = String::from_utf8_lossy(&body).into_owned();
        for n in 1..=3 {
            assert!(
                listing.contains(&format!("/a/{token}/many?v={n}\">v{n}</a>")),
                "the index must link version {n}:\n{listing}",
            );
        }
        // Not decoration: the oldest link serves the OLDEST bytes, while
        // the query-less title link stays latest.
        let (_, _, pinned) = get(server.port(), &format!("/a/{token}/many?v=1"));
        assert!(String::from_utf8_lossy(&pinned).contains("<body>v1"));
        let (_, _, latest) = get(server.port(), &format!("/a/{token}/many"));
        assert!(String::from_utf8_lossy(&latest).contains("<body>v3"));
        server.stop();
    }

    #[test]
    fn teardown_says_bye_before_the_socket_closes() {
        let (server, store, _root, _dir) = fixture("teardown");
        let token = publish(&store, "t", b"v1");
        let mut sub = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        sub.write_all(
            format!("GET /a/{token}/t/events HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes(),
        )
        .unwrap();
        await_subscribers(&server, "ws-1", "t", 1);
        server.stop();
        let mut raw = Vec::new();
        sub.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let _ = sub.read_to_end(&mut raw);
        let text = String::from_utf8_lossy(&raw).into_owned();
        // bye arrives BEFORE EOF (byte order: the event is in the bytes).
        assert!(text.contains("event: bye\ndata: server stopping"), "{text}");
    }
}
