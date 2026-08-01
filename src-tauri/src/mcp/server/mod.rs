//! The MCP transport's socket — lifecycle only.
//!
//! The command registry's external transport listens on ONE unix socket at
//! `<keepdeck_home>/mcp/mcp.sock`. This module owns that socket's life: the
//! settings toggle maps 1:1 onto [`McpServer::enable`] / [`McpServer::disable`],
//! so On means "the file exists and accepts connections" and Off means "the
//! file is gone and every client was disconnected" — while the app keeps
//! running. A kill leaves the file behind; the next enable clears it (see
//! [`start_at`]).
//!
//! What travels over a connection is one JSON line per message (the MCP stdio
//! framing, verbatim — the bundled shim forwards bytes untouched). Each line
//! is answered by the injected [`LineHandler`], so this module knows nothing
//! about MCP itself: the webview bridge owns semantics, and the lifecycle
//! stays testable with a plain echo handler.
//!
//! Two halves live next door: [`claim`] decides whether this process may
//! serve at the path at all, and [`accept`] runs the loop and the
//! per-connection threads once it may.

mod accept;
mod claim;

use std::collections::HashMap;
use std::fs::File;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use claim::{claim, prepare_socket_dir, LOCK_FILE};

/// Answers one request line with AT MOST one reply line — `None` for
/// JSON-RPC notifications, which must never be answered. Shared by every
/// connection thread, so it must be `Send + Sync` and safe to call
/// concurrently.
pub(crate) type LineHandler = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Teardown handles: one clone per live connection, so Off can actively
/// disconnect clients instead of leaving them on a dead pipe. A connection
/// removes its own entry when it ends.
pub(super) type Conns = Arc<Mutex<HashMap<u64, UnixStream>>>;

/// Managed state: the socket server, present while the toggle is on.
#[derive(Default)]
pub struct McpServer {
    inner: Mutex<Option<Running>>,
}

struct Running {
    path: PathBuf,
    /// Exclusive claim on the socket NAME, held for this server's whole
    /// life; the kernel releases it if the process dies. Dropped last.
    _lock: File,
    /// The socket this server actually bound, as (device, inode). Teardown
    /// unlinks the path ONLY while it still resolves to this — otherwise
    /// the name has moved on and deleting it would kill someone else's.
    node: (u64, u64),
    /// Dropping this wakes the accept loop's poll(2) (peer EOF) — a wake
    /// that needs no socket FILE, so Off cannot hang even after the file
    /// was deleted out from under the server. A self-connect wake had
    /// exactly that hole, and macOS does not reliably wake a parked
    /// accept(2) via shutdown(2) on the listener.
    wake: Option<UnixStream>,
    accept: Option<JoinHandle<()>>,
    /// Set by the accept loop if it dies ABNORMALLY (a broken poll). The
    /// state would otherwise keep claiming On while nothing accepts —
    /// enable() checks this and restarts instead of reporting the corpse.
    dead: Arc<AtomicBool>,
    conns: Conns,
}

impl McpServer {
    /// Bring the socket up at `path`. Idempotent: enabling while running IS
    /// the state the caller asked for, so it reports the existing socket.
    pub(crate) fn enable(&self, path: &Path, handler: LineHandler) -> Result<PathBuf, String> {
        let mut inner = self.inner.lock().expect("mcp server poisoned");
        if let Some(running) = inner.as_ref() {
            if !running.dead.load(Ordering::SeqCst) {
                return Ok(running.path.clone());
            }
            // The accept loop died abnormally — idempotence must not hand
            // back a corpse. Tear the remains down (the join returns at
            // once, the thread is gone) and start fresh.
            log::warn!("mcp: accept loop had died — restarting the socket");
            if let Some(dead) = inner.take() {
                stop(dead);
            }
        }
        let running = start_at(path, handler)?;
        let served = running.path.clone();
        *inner = Some(running);
        Ok(served)
    }

    /// Tear the socket down: stop accepting, disconnect every client, remove
    /// the file. Idempotent — Off while off is a no-op, not an error.
    ///
    /// The lock is held across the WHOLE teardown (safe: no other thread
    /// takes it — the join target never touches this mutex). Released
    /// mid-way, a concurrent enable could bind a fresh socket that the tail
    /// of this teardown then unlinks — On with no file to connect to.
    pub(crate) fn disable(&self) {
        let mut inner = self.inner.lock().expect("mcp server poisoned");
        if let Some(running) = inner.take() {
            stop(running);
        }
    }
}

fn start_at(path: &Path, handler: LineHandler) -> Result<Running, String> {
    let dir = prepare_socket_dir(path)?;
    // Own the NAME before touching it. bind(2) alone cannot arbitrate: the
    // stale-socket cleanup below UNLINKS the name first, so two instances
    // interleaving here would each remove the other's freshly bound socket
    // — and a teardown would then delete a live one. The kernel frees this
    // lock on process death, so a killed run leaves no stale claim.
    let lock = File::create(dir.join(LOCK_FILE)).map_err(|e| e.to_string())?;
    claim(&lock, path)?;
    // Under the lock, "something is in the way" is decided by
    // symlink_metadata: `exists()` follows links, so a DANGLING symlink at
    // the socket path would read as absent and then wedge bind(2) forever.
    if std::fs::symlink_metadata(path).is_ok() {
        // A connectable socket means a server we do not own is live on this
        // name (an older build, a foreign process) — refuse rather than
        // steal. Anything not answering is a killed run's leftover.
        if UnixStream::connect(path).is_ok() {
            return Err(format!(
                "{} is already served by another process",
                path.display()
            ));
        }
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    let listener = UnixListener::bind(path).map_err(|e| e.to_string())?;
    // Depth in defense only — the directory already gates access.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    let node = std::fs::metadata(path)
        .map(|meta| (meta.dev(), meta.ino()))
        .map_err(|e| e.to_string())?;
    // Non-blocking: poll(2) readiness is a hint, not a guarantee — accept
    // after POLLIN must never be able to park the loop where the teardown
    // wake cannot reach it.
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    // The teardown wake channel (see `Running::wake`).
    let (wake_rx, wake_tx) = UnixStream::pair().map_err(|e| e.to_string())?;
    let dead = Arc::new(AtomicBool::new(false));
    let conns = Conns::default();
    let accept = {
        let conns = conns.clone();
        let dead = dead.clone();
        std::thread::Builder::new()
            .name("keepdeck mcp accept".into())
            .spawn(move || accept::serve(listener, wake_rx, handler, conns, dead))
            .map_err(|e| e.to_string())?
    };

    Ok(Running {
        path: path.to_path_buf(),
        _lock: lock,
        node,
        wake: Some(wake_tx),
        accept: Some(accept),
        dead,
        conns,
    })
}

fn stop(mut running: Running) {
    // Dropping the wake handle EOFs the accept loop's poll — the wake that
    // works whether or not the socket file still exists.
    drop(running.wake.take());
    if let Some(accept) = running.accept.take() {
        let _ = accept.join();
    }
    // Off means DISCONNECTED, not merely unreachable: a half-open client
    // would otherwise sit on a dead pipe believing it is still served.
    let drained: Vec<UnixStream> = {
        let mut conns = running.conns.lock().expect("mcp conns poisoned");
        conns.drain().map(|(_, conn)| conn).collect()
    };
    for conn in drained {
        let _ = conn.shutdown(std::net::Shutdown::Both);
    }
    // Unlink the name only while it still resolves to the socket THIS
    // server bound. The lock makes another instance's claim impossible
    // while we hold it, but a name that has moved on (an external rm, a
    // future path change) must never be deleted on someone else's behalf.
    let ours = std::fs::metadata(&running.path)
        .map(|meta| (meta.dev(), meta.ino()) == running.node)
        .unwrap_or(false);
    if ours {
        let _ = std::fs::remove_file(&running.path);
    }
}

#[cfg(test)]
pub(super) mod test_support {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A scratch directory THIS call created — the create is the claim, so
    /// a leftover from an earlier run (pids are recycled, and nothing here
    /// sweeps /tmp) can never be handed to a test as if it were fresh.
    /// Names stay short: unix socket paths cap at ~104 bytes on macOS.
    fn temp_root() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        loop {
            let dir = std::env::temp_dir().join(format!(
                "kd-mcp-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            if std::fs::create_dir(&dir).is_ok() {
                return dir;
            }
        }
    }

    /// A socket directory that does NOT exist yet, inside a fresh root.
    pub(super) fn temp_base() -> PathBuf {
        temp_root().join("mcp")
    }

    /// A fresh socket path whose directory already exists.
    pub(super) fn temp_sock() -> PathBuf {
        let dir = temp_base();
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join("mcp.sock")
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::temp_sock;
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::time::Duration;

    fn upper() -> LineHandler {
        Arc::new(|line: &str| Some(line.to_uppercase()))
    }

    /// Connect, send one line, read one reply line.
    fn roundtrip(path: &Path, msg: &str) -> String {
        let mut stream = UnixStream::connect(path).expect("connect");
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        writeln!(stream, "{msg}").expect("write");
        let mut reply = String::new();
        reader.read_line(&mut reply).expect("read");
        reply.trim_end().to_string()
    }

    #[test]
    fn serves_lines_through_the_handler_with_owner_only_perms() {
        let path = temp_sock();
        let running = start_at(&path, upper()).expect("start");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        // The directory is the load-bearing permission: 0700 even if it
        // pre-existed looser (start_at enforces, not just creates).
        let dir_mode = std::fs::metadata(path.parent().expect("parent"))
            .expect("dir metadata")
            .permissions()
            .mode();
        assert_eq!(dir_mode & 0o777, 0o700);
        assert_eq!(roundtrip(&path, "hello"), "HELLO");
        stop(running);
    }

    #[test]
    fn a_dangling_symlink_at_the_socket_path_is_cleared() {
        // `exists()` follows links, so a dangling one reads as absent and
        // then wedges bind(2) forever — the staleness check must not.
        let path = temp_sock();
        std::os::unix::fs::symlink(path.with_extension("gone"), &path).expect("symlink");
        let running = start_at(&path, upper()).expect("start over a dangling symlink");
        assert_eq!(roundtrip(&path, "up"), "UP");
        stop(running);
    }

    #[test]
    fn the_name_stays_owned_even_when_the_socket_file_vanishes() {
        // The teardown UNLINKS the name, and the stale-file cleanup unlinks
        // it too — so without an owner's claim a second server could bind
        // over a live one and later delete its socket. The claim outlives
        // the file: only the owning process going away frees the name.
        let path = temp_sock();
        let first = start_at(&path, upper()).expect("first");
        std::fs::remove_file(&path).expect("the file vanishes");
        assert!(
            start_at(&path, upper()).is_err(),
            "the name must stay owned while its server lives"
        );
        stop(first);
        // Owner gone → the name is free again. Not necessarily INSTANTLY:
        // a claim survives in any process that forked while we held it,
        // until that child execs — which is what `claim`'s wait covers.
        let second = start_at(&path, upper())
            .unwrap_or_else(|e| panic!("the name must be free once its owner stopped: {e}"));
        stop(second);
    }

    #[test]
    fn a_claim_held_only_in_passing_does_not_refuse_a_restart() {
        // The whole start path, not just `claim`: a user flipping the
        // toggle Off then On lands in the window where a forked child still
        // holds the released claim, and must not be told another instance
        // owns the socket.
        let path = temp_sock();
        let holder = File::create(path.parent().unwrap().join(LOCK_FILE)).expect("lock file");
        holder.try_lock().expect("hold the claim");
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            drop(holder);
        });
        let running =
            start_at(&path, upper()).expect("a claim held in passing must not refuse a restart");
        stop(running);
    }

    #[test]
    fn teardown_leaves_a_socket_it_no_longer_owns_alone() {
        let path = temp_sock();
        let running = start_at(&path, upper()).expect("start");
        // The name moves on to a different inode (an external rm plus
        // whatever took its place). Deleting THAT would be deleting on
        // someone else's behalf.
        std::fs::remove_file(&path).expect("rm");
        std::fs::write(&path, b"not ours").expect("replace");
        stop(running);
        assert!(path.exists(), "a foreign file at the name must survive Off");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn replaces_a_stale_socket_file() {
        let path = temp_sock();
        // A killed run's leftover: a path nothing answers on. A plain file
        // exercises the same branch — exists, but connect fails.
        std::fs::write(&path, b"").expect("stale file");
        let running = start_at(&path, upper()).expect("start over stale");
        assert_eq!(roundtrip(&path, "up"), "UP");
        stop(running);
    }

    #[test]
    fn refuses_a_socket_another_server_holds() {
        let path = temp_sock();
        let running = start_at(&path, upper()).expect("first");
        let second = start_at(&path, upper());
        assert!(second.is_err(), "a live socket must not be stolen");
        // The refusal must not have torn down the live server either.
        assert_eq!(roundtrip(&path, "still"), "STILL");
        stop(running);
    }

    #[test]
    fn disable_disconnects_clients_and_removes_the_socket() {
        let path = temp_sock();
        let server = McpServer::default();
        server.enable(&path, upper()).expect("enable");
        let stream = UnixStream::connect(&path).expect("connect");
        let mut reader = BufReader::new(stream);

        server.disable();

        // The blocked read must END (EOF or reset) — a client left believing
        // it is connected is exactly what Off must not produce.
        let mut buf = String::new();
        let read = reader.read_line(&mut buf);
        assert!(matches!(read, Ok(0)) || read.is_err());
        assert!(!path.exists(), "Off leaves no socket file behind");
    }

    #[test]
    fn disable_completes_even_after_the_socket_file_was_deleted() {
        let path = temp_sock();
        let server = McpServer::default();
        server.enable(&path, upper()).expect("enable");
        std::fs::remove_file(&path).expect("delete the file out from under the server");
        // A wake that depends on the file (self-connect) hangs here forever;
        // the poll-channel wake must not.
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            server.disable();
            let _ = done_tx.send(());
        });
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("disable wedged — the accept loop was never woken");
        worker.join().unwrap();
    }

    #[test]
    fn re_enable_serves_again_and_enable_is_idempotent() {
        let path = temp_sock();
        let server = McpServer::default();
        server.enable(&path, upper()).expect("enable");
        server.disable();
        let served = server.enable(&path, upper()).expect("re-enable");
        assert_eq!(served, path);
        // A second enable reports the running socket instead of failing —
        // the toggle's On is a state, not an action counter.
        let again = server.enable(&path, upper()).expect("enable while on");
        assert_eq!(again, path);
        assert_eq!(roundtrip(&path, "back"), "BACK");
        server.disable();
    }
}
