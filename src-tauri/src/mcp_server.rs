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

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// Answers one request line with AT MOST one reply line — `None` for
/// JSON-RPC notifications, which must never be answered. Shared by every
/// connection thread, so it must be `Send + Sync` and safe to call
/// concurrently.
pub(crate) type LineHandler = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

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
    /// Teardown handles: a clone per live connection, so Off can actively
    /// disconnect clients instead of leaving them on a dead pipe.
    conns: Arc<Mutex<HashMap<u64, UnixStream>>>,
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

/// The lock file that makes ownership of the socket name exclusive.
const LOCK_FILE: &str = "lock";

/// How long the accept loop waits out a transient accept failure (fd
/// exhaustion), and how many consecutive failures it tolerates before
/// declaring the socket dead instead of retrying at 10Hz forever.
const ACCEPT_FAILURE_BACKOFF: Duration = Duration::from_millis(100);
const ACCEPT_FAILURE_LIMIT: u32 = 10;

/// Ready the socket's directory and return it. The directory IS the
/// transport's permission model (see paths::mcp_socket), so it is created
/// 0700 — never created loose and tightened after, which would leave a
/// window where another user can open a directory handle that survives the
/// chmod. A pre-existing directory is validated and retightened; a symlink
/// or a plain file in its place is refused rather than followed, so the
/// mode this code enforces is always the mode of the directory it serves
/// from.
fn prepare_socket_dir(path: &Path) -> Result<PathBuf, String> {
    let dir = path
        .parent()
        .ok_or_else(|| "the MCP socket path has no directory".to_string())?;
    if let Some(home) = dir.parent() {
        std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "{} is a symlink — refusing to serve the MCP socket through it",
                    dir.display()
                ));
            }
            if !meta.is_dir() {
                return Err(format!("{} is not a directory", dir.display()));
            }
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Err(e) => return Err(e.to_string()),
    }
    Ok(dir.to_path_buf())
}

/// How long a claim waits out a lock held only in passing, and how often it
/// re-checks. A released claim is NOT free instantly: every process this app
/// spawns (a PTY agent, a git child) inherits open descriptors across fork
/// and keeps our lock alive until it execs, so a claim taken right after a
/// release can still see the old one — measured at ~3ms under load, which
/// is exactly the Off→On gap a user produces by flipping the toggle twice.
/// Waiting costs a genuine refusal a fraction of a second; not waiting costs
/// a legitimate re-enable a false "another instance owns this".
const CLAIM_TIMEOUT: Duration = Duration::from_millis(250);
const CLAIM_RETRY: Duration = Duration::from_millis(5);

/// Take the exclusive claim on the socket name. Contention and failure are
/// DIFFERENT answers: a name another instance holds is a refusal the user
/// can act on, while a failed lock call is a fault that must say what it
/// was — collapsing the two hid an interrupted call behind a wrong
/// diagnosis. `flock(2)` is interruptible, so a signal is retried too.
fn claim(lock: &File, path: &Path) -> Result<(), String> {
    let deadline = std::time::Instant::now() + CLAIM_TIMEOUT;
    loop {
        match lock.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "{} is already served by another KeepDeck instance",
                        path.display()
                    ));
                }
                std::thread::sleep(CLAIM_RETRY);
            }
            Err(std::fs::TryLockError::Error(e))
                if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(std::fs::TryLockError::Error(e)) => {
                return Err(format!("claiming {} failed: {e}", path.display()))
            }
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
    let conns: Arc<Mutex<HashMap<u64, UnixStream>>> = Arc::default();
    let accept = {
        let conns = conns.clone();
        let dead = dead.clone();
        std::thread::Builder::new()
            .name("keepdeck mcp accept".into())
            .spawn(move || {
                let mut next_id = 0u64;
                let mut failures = 0u32;
                loop {
                    match poll_verdict(&listener, &wake_rx) {
                        PollVerdict::Teardown => break,
                        PollVerdict::Broken => {
                            // Visible death, not a silent one: the flag makes
                            // the next enable restart instead of reporting a
                            // corpse as running.
                            dead.store(true, Ordering::SeqCst);
                            break;
                        }
                        PollVerdict::Accept => {}
                    }
                    let stream = match listener.accept() {
                        Ok((stream, _)) => stream,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                        Err(e) => {
                            // fd exhaustion and kin: the pending connection
                            // stays queued, so poll re-fires immediately —
                            // back off instead of spinning a core. A fault
                            // that never clears must not back off FOREVER,
                            // logging every 100ms into a capped log budget:
                            // give up, and let the flag report the death.
                            failures += 1;
                            if failures >= ACCEPT_FAILURE_LIMIT {
                                log::error!(
                                    "mcp: accept failed {failures} times, socket dead \
                                     until re-enable: {e}"
                                );
                                dead.store(true, Ordering::SeqCst);
                                break;
                            }
                            log::warn!("mcp: accept failed: {e}");
                            std::thread::sleep(ACCEPT_FAILURE_BACKOFF);
                            continue;
                        }
                    };
                    failures = 0;
                    // Connection I/O is blocking (BufReader::lines) — undo
                    // the listener's inherited non-blocking mode.
                    if stream.set_nonblocking(false).is_err() {
                        continue;
                    }
                    next_id += 1;
                    // No teardown handle, no service: a connection Off could
                    // not disconnect would outlive the toggle and keep
                    // driving the deck — the one promise this module makes.
                    match stream.try_clone() {
                        Ok(clone) => {
                            conns
                                .lock()
                                .expect("mcp conns poisoned")
                                .insert(next_id, clone);
                            if let Err(e) =
                                spawn_connection(next_id, stream, handler.clone(), conns.clone())
                            {
                                // No thread, no service — and the teardown
                                // clone must not keep the doomed connection
                                // open past this refusal.
                                log::warn!("mcp: dropping connection, no thread: {e}");
                                if let Some(conn) =
                                    conns.lock().expect("mcp conns poisoned").remove(&next_id)
                                {
                                    let _ = conn.shutdown(std::net::Shutdown::Both);
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("mcp: dropping connection, no teardown handle: {e}");
                        }
                    }
                }
            })
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

enum PollVerdict {
    /// The listener has a pending connection.
    Accept,
    /// The wake channel's far end was dropped — orderly teardown.
    Teardown,
    /// poll(2) itself failed (not EINTR) — the loop cannot serve on.
    Broken,
}

/// Park until the listener is readable or teardown wakes us. poll(2) rather
/// than a bare blocking accept: the only reliable way OUT of a parked
/// accept is a connection, and teardown cannot make one once the socket
/// file is gone.
fn poll_verdict(listener: &UnixListener, wake: &UnixStream) -> PollVerdict {
    let mut fds = [
        libc::pollfd {
            fd: listener.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: wake.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    loop {
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, -1) };
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            log::warn!("mcp: poll failed, socket dead until re-enable: {error}");
            return PollVerdict::Broken;
        }
        // Teardown wins over a pending connection: Off means Off.
        if fds[1].revents != 0 {
            return PollVerdict::Teardown;
        }
        if fds[0].revents != 0 {
            return PollVerdict::Accept;
        }
    }
}

/// One thread per connection: read a line, answer at most a line. Ends on
/// client EOF, on a write failure, or when `stop` shuts the stream down —
/// and then removes its own teardown handle. The spawn error propagates:
/// the caller must un-register the connection it pre-registered.
fn spawn_connection(
    id: u64,
    stream: UnixStream,
    handler: LineHandler,
    conns: Arc<Mutex<HashMap<u64, UnixStream>>>,
) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("keepdeck mcp conn".into())
        .spawn(move || {
            let Ok(mut writer) = stream.try_clone() else {
                conns.lock().expect("mcp conns poisoned").remove(&id);
                return;
            };
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                if let Some(reply) = handler(&line) {
                    if writeln!(writer, "{reply}").is_err() {
                        break;
                    }
                }
            }
            conns.lock().expect("mcp conns poisoned").remove(&id);
        })
        .map(|_| ())
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
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    fn upper() -> LineHandler {
        Arc::new(|line: &str| Some(line.to_uppercase()))
    }

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
    fn temp_base() -> PathBuf {
        temp_root().join("mcp")
    }

    /// A fresh socket path whose directory already exists.
    fn temp_sock() -> PathBuf {
        let dir = temp_base();
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join("mcp.sock")
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
    fn a_loosened_leftover_directory_is_retightened() {
        let path = temp_sock();
        let parent = path.parent().expect("parent").to_path_buf();
        std::fs::create_dir_all(&parent).expect("pre-create");
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755))
            .expect("loosen");
        let running = start_at(&path, upper()).expect("start");
        let mode = std::fs::metadata(&parent).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        stop(running);
    }

    #[test]
    fn a_none_reply_writes_nothing_and_keeps_the_connection() {
        let path = temp_sock();
        // Notification-style lines (here: a '!' prefix) produce no reply;
        // the NEXT request's reply must be the first thing the client reads.
        let handler: LineHandler = Arc::new(|line: &str| {
            (!line.starts_with('!')).then(|| line.to_uppercase())
        });
        let running = start_at(&path, handler).expect("start");
        let mut stream = UnixStream::connect(&path).expect("connect");
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        writeln!(stream, "!notify").expect("write");
        writeln!(stream, "request").expect("write");
        let mut reply = String::new();
        reader.read_line(&mut reply).expect("read");
        assert_eq!(reply.trim_end(), "REQUEST");
        stop(running);
    }

    #[test]
    fn a_directory_this_start_creates_is_born_owner_only() {
        // Not "created loose, tightened after": a window there would let
        // another user open a dirfd that survives the chmod.
        let path = temp_base().join("mcp.sock");
        let running = start_at(&path, upper()).expect("start");
        let mode = std::fs::metadata(path.parent().unwrap())
            .expect("meta")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        stop(running);
    }

    #[test]
    fn a_symlinked_socket_directory_is_refused() {
        // Following it would chmod — and serve from — whatever it points at.
        let base = temp_base();
        let real = base.join("real");
        std::fs::create_dir_all(&real).expect("real dir");
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        let refused = start_at(&link.join("mcp.sock"), upper());
        assert!(refused.is_err(), "a symlinked socket dir must be refused");
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
        // Releasing a claim does not free it instantly: a process that
        // forked while we held it keeps it alive until it execs, and this
        // app forks constantly (PTY agents, git). A user flipping the
        // toggle Off then On lands in exactly that window and must not be
        // told another instance owns the socket.
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
