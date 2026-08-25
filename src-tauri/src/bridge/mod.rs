//! The CLI bridge — the one-way channel a pane's own agent process uses to
//! report facts back to KeepDeck: its session id (identity) and its usage
//! reports (rate-limit windows, tokens, cost).
//!
//! This module is the composition: watch the inbox [`inbox`] publishes, parse
//! what lands with [`wire`], emit it, consume the file. The two halves it
//! composes change for different reasons — the wire schema when the deck
//! needs a new field, the inbox when locking or sweeping semantics do — and
//! only the wire half is shared outside the bridge (the session tailer emits
//! the same shapes for what it recovers from transcripts).
//!
//! Transport: a per-RUN inbox directory. Each launch mints
//! `<keepdeck_home>/bridge/run-<uuid>/`, holds an OS file lock on `lock`
//! inside it for the process's lifetime, and watches for `*.json` envelope
//! drops. Reporters (hook/plugin shipped with KeepDeck, armed per spawn via
//! the single `KEEPDECK_BRIDGE` env var) write one uniquely-named file per
//! message — tmp + rename, so the watcher never sees a torn file — and the
//! watcher parses, emits and consumes it.
//!
//! The bridge is an ephemeral signal bus, not a durable queue: every run
//! starts with a fresh empty inbox and whatever a dead run left is deleted
//! unread. Envelopes are data, never code: size-capped, schema-validated,
//! logged only after control characters are stripped, and carrying a
//! per-spawn token the webview verifies against the pane's own spawn plan
//! before applying anything.

mod http;
mod inbox;
mod nudge;
mod reply;
mod spool;
mod waiters;
mod wire;

use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use wire::{interpret, printable, Inbound, SESSION_BOUND_EVENT};
// Only what the rest of the crate actually consumes: the session tailer emits
// `Report` on these two event names. `SessionBound` and its event name never
// leave the bridge — a binding is built from an envelope and emitted in the
// same breath, and nothing outside re-emits one.
pub use wire::{Report, AGENT_STATUS_EVENT, USAGE_REPORT_EVENT};

/// An envelope larger than this is dropped unread — reporters send small
/// JSON (a statusline payload runs a few KB; the cap leaves generous
/// headroom for bloated workspace lists), anything bigger is not ours.
const MAX_ENVELOPE_BYTES: u64 = 256 * 1024;

/// This run's live bridge — kept in Tauri managed state so the lock fd and
/// the watcher survive for the app's lifetime.
pub struct Bridge {
    /// Where this run's bridge answers, whole. Published to every pane at
    /// spawn so a reporter can reach the deck without a file — and composed
    /// once, so nothing downstream assembles an address of its own.
    pub url: String,
    /// Hooks parked on an open connection, waiting for the deck's answer.
    /// Shared with the surface: the route parks, `bridge_reply` unparks.
    waiters: std::sync::Arc<waiters::Waiters>,
    /// Held for the run: dropping it would take the surface down.
    _surface: http::Surface,
    /// The inbox spawns advertise via `KEEPDECK_BRIDGE`.
    pub run_dir: PathBuf,
    _lock: File,
    _watcher: notify::RecommendedWatcher,
}

/// Boot the bridge: sweep orphaned inboxes, publish this run's own, watch it.
pub fn start(app: &AppHandle) -> Result<Bridge, String> {
    let home = crate::paths::keepdeck_home().ok_or("no home directory for the bridge")?;
    // Pre-bridge installs dropped postbacks into one shared spool; reap it
    // once so it doesn't sit around forever.
    let _ = fs::remove_dir_all(home.join("session-spool"));

    let root = home.join("bridge");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    inbox::restrict(&root);

    let (run_dir, lock, swept) = inbox::boot(&root)?;
    log::info!(
        "bridge: inbox {} (swept {swept} orphaned run dir(s))",
        run_dir.display()
    );

    let emitter = app.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        let Ok(event) = event else { return };
        // Reporters write via tmp + rename, so a Create/Modify means a whole
        // file. Anything unparsable is consumed and dropped (never loops).
        if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            return;
        }
        for path in &event.paths {
            deliver(&emitter, path);
        }
    })
    .map_err(|e| e.to_string())?;
    // RECURSIVE: every pane owns a subdirectory of this one ([`spool::pane_dir`]),
    // so the envelopes arrive one level down.
    watcher
        .watch(&run_dir, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // Before anything can be spawned: the address has to exist by the time
    // a pane's environment is built, or that pane never learns it.
    let waiters = std::sync::Arc::new(waiters::Waiters::default());
    let surface = http::serve(app.clone(), std::sync::Arc::clone(&waiters))?;
    log::info!("bridge: surface at {}", surface.url);

    Ok(Bridge {
        url: surface.url.clone(),
        waiters,
        _surface: surface,
        run_dir,
        _lock: lock,
        _watcher: watcher,
    })
}

/// Answer a hook that is waiting on this run's inbox.
///
/// The deck decides — it holds the deck, the queues and the status lane —
/// and Rust only carries the answer back, exactly as it carries envelopes
/// the other way. A failure is logged rather than raised: a hook that never
/// sees its file times out and behaves as if there were nothing for it,
/// which is the recoverable direction.
#[tauri::command]
pub fn bridge_reply(
    app: AppHandle,
    bridge: tauri::State<Bridge>,
    pane: String,
    id: String,
    body: String,
) {
    // A hook parked on an open connection is answered THERE, and no file is
    // written at all. Note what disappears with it: the file lane cannot tell
    // "the hook took the answer" from "the hook died before coming for it",
    // so it waits out a window and reports uncollected on a guess. A send
    // that succeeds on a live connection is the hook having it — the window
    // does not narrow here, it stops existing.
    if bridge.waiters.resolve(&id, body.clone()) {
        return;
    }
    if let Err(e) = reply::write(&bridge.run_dir, &pane, &id, &body) {
        log::warn!("bridge: {e}");
        // The deck has already taken those messages out of its queue. A
        // refusal here used to end the story — no file, so no watcher below,
        // so nothing ever told the deck to put them back and they aged out
        // silently. Whatever the reason a reply cannot be written, the
        // outcome for the mail is the same one the watcher reports.
        let _ = app.emit(REPLY_UNCOLLECTED_EVENT, ReplyUncollected { pane, id });
        return;
    }
    // An EMPTY answer is the common one — most turns end with nothing waiting
    // — and it carries nothing to lose, so nobody has to come for it. An
    // answer with content does: the deck has already handed those messages
    // over, and if the hook timed out first they are gone. Watch for it.
    if body.is_empty() {
        return;
    }
    let run_dir = bridge.run_dir.clone();
    std::thread::spawn(move || {
        std::thread::sleep(reply::HOOK_WAIT);
        if reply::was_collected(&run_dir, &pane, &id) {
            log::info!("bridge: reply {id} collected");
            return;
        }
        log::warn!("bridge: reply {id} was never collected — the hook did not read it");
        reply::discard(&run_dir, &pane, &id);
        // Observing it is not enough: those messages left the deck's queue to
        // be written here, so unless the deck puts them back they are gone
        // with nobody told — the one failure mode this whole channel is
        // supposed to make impossible. The decision to retry belongs upstairs,
        // so this reports the fact and nothing more.
        let _ = app.emit(REPLY_UNCOLLECTED_EVENT, ReplyUncollected { pane, id });
    });
}

/// A reply nobody came for. The deck restores the messages it names.
pub const REPLY_UNCOLLECTED_EVENT: &str = "deck://bridge/reply-uncollected";

#[derive(Clone, serde::Serialize)]
struct ReplyUncollected {
    pane: String,
    id: String,
}

/// The inbox one pane's reporters write to and read answers from, created
/// here so it exists before the agent does.
///
/// Handed out at spawn and put in that pane's `KEEPDECK_BRIDGE`, so a
/// reporter needs no knowledge of the layout — it writes where it was told.
/// Errors are surfaced: a spawn whose reporters have nowhere to write should
/// be armed without a bridge rather than armed with a path that does not
/// exist, and only the caller can make that choice.
#[tauri::command]
pub fn bridge_pane_dir(bridge: tauri::State<Bridge>, pane: String) -> Result<String, String> {
    spool::pane_dir(&bridge.run_dir, &pane).map(|dir| dir.to_string_lossy().into_owned())
}

/// Tell a pane's own in-process reporter that mail is waiting for it.
///
/// The terminal equivalent of this types a line into the pane. That is the
/// floor every CLI can meet, not the goal: an agent whose reporter runs
/// inside its own process can be told directly, and then nothing KeepDeck
/// does ever appears in front of the model as if the user had typed it.
///
/// Fire-and-forget by design. Whether anybody is listening is not a fact this
/// side can observe — the reporter answers by ASKING, through the reply path
/// above, and a pane that never asks lets its mail expire and be reported
/// back to the sender. Guessing here would only add a second story.
#[tauri::command]
pub fn bridge_nudge(bridge: tauri::State<Bridge>, pane: String) {
    match nudge::ring(&bridge.run_dir, &pane) {
        Ok(()) => log::info!("bridge: nudged pane={}", printable(&pane)),
        Err(e) => log::warn!("bridge: {e}"),
    }
}

/// Why an inbox file yielded no event.
enum Rejected {
    /// IO race (writer mid-rename, file already consumed) — leave the file,
    /// it re-fires on its own next event.
    Transient,
    /// Bad content — consumed and dropped, with the reason for the log.
    Dropped(String),
}

/// Read → interpret → emit → consume one inbox file.
fn deliver(app: &AppHandle, path: &Path) {
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return; // tmp staging files, the lock, and strays
    }
    match consume_file(path) {
        Ok(inbound) => emit_inbound(app, inbound),
        Err(Rejected::Transient) => return,
        // A reporter wrote garbage — consumed and dropped by design, but a
        // trace is the difference between "hook broken" and "hook never ran".
        Err(Rejected::Dropped(reason)) => log::warn!("bridge: dropped envelope: {reason}"),
    }
    if let Err(e) = fs::remove_file(path) {
        // A stuck envelope re-fires on every inbox event until it's gone.
        log::warn!("bridge: consuming {} failed: {e}", path.display());
    }
}

/// One interpreted envelope → one event, whatever carried it here.
///
/// The file watcher and the http route both end HERE, and that is the point:
/// an envelope means the same thing and lands in the same place regardless of
/// which door it arrived through. A second copy of this match would be two
/// definitions of what a report IS, drifting apart one lane at a time.
fn emit_inbound(app: &AppHandle, inbound: Inbound) {
    match inbound {
        Inbound::SessionBound(bound) => {
            log::info!(
                "bridge: bound pane={} session={}",
                printable(&bound.pane_id),
                printable(&bound.session_id),
            );
            if let Err(e) = app.emit(SESSION_BOUND_EVENT, &bound) {
                log::warn!("bridge: emitting {SESSION_BOUND_EVENT} failed: {e}");
            }
        }
        // Opaque reports arrive continuously (per statusline update / turn
        // transition) — debug, not info, or they'd dominate keepdeck.log.
        Inbound::Opaque { event, report } => {
            log::debug!("bridge: {event} pane={}", printable(&report.pane_id));
            if let Err(e) = app.emit(event, &report) {
                log::warn!("bridge: emitting {event} failed: {e}");
            }
        }
    }
}

/// One inbox file → one event, enforcing the size cap before reading.
/// Only a VANISHED file is transient (already consumed / writer mid-rename —
/// it re-fires or is gone for good reason); any other IO failure is dropped
/// like garbage, because a completed file gets no further fs events and
/// would otherwise sit in the inbox unread forever.
fn consume_file(path: &Path) -> Result<Inbound, Rejected> {
    let vanished_or = |e: std::io::Error, what: &str| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Rejected::Transient
        } else {
            Rejected::Dropped(format!("{what}: {e}"))
        }
    };
    // OPEN first, then ask the open file what it is. An envelope is a regular
    // file a reporter renamed into place, and every other kind of thing is a
    // way to make this thread do something else: a symlink reads a file
    // somewhere else entirely, a fifo blocks the read forever and takes the
    // whole bridge down with it — session bindings, usage, mail asks, for
    // every pane at once.
    //
    // Statting the PATH and then reading the PATH resolves it twice, so the
    // two can disagree: swap the file between them and the checks were done
    // on something else. Everything below is asked of the descriptor, which
    // names one object nobody can substitute.
    //
    // Not a privilege boundary — the panes run as the same user and can read
    // these files directly — but the inbox has one job, and reading anything
    // other than what a reporter wrote is not it.
    let file = open_plain_file(path).map_err(|e| vanished_or(e, "unopenable envelope"))?;
    let meta = file
        .metadata()
        .map_err(|e| vanished_or(e, "unstattable envelope"))?;
    if !meta.is_file() {
        return Err(Rejected::Dropped("not a regular file".into()));
    }
    if meta.len() > MAX_ENVELOPE_BYTES {
        return Err(Rejected::Dropped(format!(
            "oversized envelope ({} bytes)",
            meta.len()
        )));
    }
    // Bounded regardless of what the stat said: a file being appended to
    // while this reads would otherwise slip past the cap it just passed.
    use std::io::Read as _;
    let mut content = String::new();
    file.take(MAX_ENVELOPE_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|e| vanished_or(e, "unreadable envelope"))?;
    if content.len() as u64 > MAX_ENVELOPE_BYTES {
        return Err(Rejected::Dropped("oversized envelope (grew while reading)".into()));
    }
    interpret(&content).map_err(Rejected::Dropped)
}

/// Open a path as a plain file, refusing to follow a symlink and refusing to
/// wait on anything that would block.
///
/// `O_NOFOLLOW` makes a symlink an error rather than a redirection, and
/// `O_NONBLOCK` is what stops a fifo parking this thread inside `open` —
/// opening one for reading waits for a writer, forever if none comes, and
/// this runs on the notify watcher's only thread. Both are refusals, not
/// mitigations: the caller checks `is_file()` on the descriptor anyway, so a
/// device that opens fine is still dropped.
fn open_plain_file(path: &Path) -> std::io::Result<fs::File> {
    // Off unix there are no such flags, so the link is refused BEFORE the
    // open instead. It is a smaller guarantee — a swap between this check and
    // the open is not covered — but it is the difference between refusing a
    // symlink and following one, and this file ships to whatever the build
    // targets rather than only to the platform it was written on.
    #[cfg(not(unix))]
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "refusing a symlink",
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NOFOLLOW makes a symlink an error rather than a redirection.
        // O_NONBLOCK is not a refusal — it is what stops `open` itself
        // PARKING on a fifo, which waits for a writer; the `is_file()` check
        // at the caller is what refuses one.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::wire::tests::envelope;
    use super::wire::SessionBound;
    use super::*;

    #[test]
    fn consuming_enforces_the_size_cap_and_reads_valid_envelopes() {
        let root = tempfile::tempdir().unwrap();
        let big = root.path().join("big.json");
        fs::write(&big, "x".repeat((MAX_ENVELOPE_BYTES + 1) as usize)).unwrap();
        assert!(matches!(
            consume_file(&big),
            Err(Rejected::Dropped(reason)) if reason.contains("oversized")
        ));

        let ok = root.path().join("ok.json");
        fs::write(&ok, envelope(1, "session.bound", "pane-1", "tok", "sid")).unwrap();
        assert_eq!(
            consume_file(&ok).map_err(|_| ()),
            Ok(Inbound::SessionBound(SessionBound {
                pane_id: "pane-1".into(),
                session_id: "sid".into(),
                token: "tok".into(),
                agent: "claude".into(),
                transcript_path: None,
                source: None,
                reporter: None,
            }))
        );

        let gone = root.path().join("missing.json");
        assert!(matches!(consume_file(&gone), Err(Rejected::Transient)));

        // A completed file that can't be READ (non-UTF-8 here) is garbage to
        // consume, not a transient to retry — it gets no further fs events.
        let binary = root.path().join("binary.json");
        fs::write(&binary, [0xff, 0xfe, 0x00, 0x80]).unwrap();
        assert!(matches!(
            consume_file(&binary),
            Err(Rejected::Dropped(reason)) if reason.contains("unreadable")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn an_envelope_that_is_not_a_regular_file_is_dropped_unread() {
        // An envelope is a file a reporter renamed into place. Anything else
        // is a way to make this thread do something other than its job: a
        // symlink reads a file somewhere else, a fifo blocks forever and
        // takes the whole bridge down with it.
        let root = tempfile::tempdir().unwrap();
        let elsewhere = root.path().join("elsewhere.txt");
        fs::write(&elsewhere, envelope(1, "session.bound", "pane-1", "tok", "sid")).unwrap();
        let link = root.path().join("linked.json");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();

        // Refused at OPEN — the link is never followed, so the target's
        // content cannot reach `interpret` however valid it happens to be.
        assert!(matches!(consume_file(&link), Err(Rejected::Dropped(_))));
        // A directory named like an envelope is refused too, rather than read.
        let dir = root.path().join("dir.json");
        fs::create_dir(&dir).unwrap();
        assert!(matches!(consume_file(&dir), Err(Rejected::Dropped(_))));
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_named_like_an_envelope_does_not_park_the_watcher() {
        // The hazard that makes this worth doing at all. Opening a fifo for
        // reading waits for a writer — forever, if none comes — and this runs
        // on the notify watcher's only thread, so one of these would stop
        // session bindings, usage and mail asks for every pane at once.
        let root = tempfile::tempdir().unwrap();
        let pipe = root.path().join("pipe.json");
        let name = std::ffi::CString::new(pipe.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);

        let began = std::time::Instant::now();
        assert!(matches!(consume_file(&pipe), Err(Rejected::Dropped(_))));
        assert!(began.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn the_size_cap_names_which_check_refused() {
        // Two checks, two moments: the stat, and the bounded read that covers
        // a file still being appended to. They must be distinguishable, or a
        // test asserting only "oversized" passes with the second one deleted —
        // which is exactly what the first version of this test did.
        //
        // Only the stat path is reachable from a test: the grow has to happen
        // between two statements inside `consume_file`. The read bound stays
        // as the thing that makes the cap true rather than merely checked.
        let root = tempfile::tempdir().unwrap();
        let big = root.path().join("big.json");
        fs::write(&big, "x".repeat(MAX_ENVELOPE_BYTES as usize + 1)).unwrap();
        assert!(matches!(
            consume_file(&big),
            Err(Rejected::Dropped(reason)) if reason.contains("oversized envelope (")
        ));
        // And one byte under is read rather than refused (it is not an
        // envelope, so it is dropped — by the PARSER, saying so).
        let edge = root.path().join("edge.json");
        fs::write(&edge, "x".repeat(MAX_ENVELOPE_BYTES as usize)).unwrap();
        assert!(matches!(
            consume_file(&edge),
            Err(Rejected::Dropped(reason)) if reason.contains("not an envelope")
        ));
    }
}
