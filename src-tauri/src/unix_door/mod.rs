//! A door on a unix socket — its life only. KeepDeck's MCP server and the
//! bridge each open one.
//!
//! Open means the name is owned and the file is bound, 0600 in a 0700
//! directory, and every connection is handed — on a thread of its own, with
//! the process on its far end as the kernel names it — to whoever opened the
//! door. Closed, dropped, means the file is gone and every connection was
//! cut. A kill leaves the file behind; the next open on that name clears it
//! (see [`UnixDoor::open`]).
//!
//! What travels over a connection is not this module's: MCP speaks one JSON
//! line per message on its door, the bridge one HTTP request per
//! connection. The kernel's word on the peer is the reason both are unix
//! sockets at all — a TCP peer is no process anyone can name.
//!
//! Two halves live next door: [`claim`] decides whether this process may
//! serve at the path at all, and [`accept`] runs the loop and the
//! per-connection threads once it may.

mod accept;
mod claim;
mod socket_dir;

use std::collections::HashMap;
use std::fs::File;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use claim::{claim, LOCK_FILE};
use socket_dir::prepare_socket_dir;

/// What a door does with one connection: handed the stream and the process
/// on its far end, as the kernel recorded it at connect (None when it could
/// not be told), on the connection's own thread. The connection is over
/// when it returns. Shared across the accept loop's threads.
pub(crate) type Serve = Arc<dyn Fn(UnixStream, Option<u32>) + Send + Sync>;

/// Teardown handles: one clone per live connection, so closing the door can
/// actively cut its clients instead of leaving them on a dead pipe. A
/// connection removes its own entry when it ends.
type Conns = Arc<Mutex<HashMap<u64, UnixStream>>>;

/// An open door. Dropping it closes it: stop accepting, cut every
/// connection, remove the file.
pub(crate) struct UnixDoor {
    path: PathBuf,
    /// Exclusive claim on the socket NAME, held for the door's whole life;
    /// the kernel releases it if the process dies.
    _lock: File,
    /// The socket this door actually bound, as (device, inode). Closing
    /// unlinks the path ONLY while it still resolves to this — otherwise the
    /// name has moved on and deleting it would kill someone else's.
    node: (u64, u64),
    /// Dropping this wakes the accept loop's poll(2) (peer EOF) — a wake
    /// that needs no socket FILE, so closing cannot hang even after the file
    /// was deleted out from under the door. A self-connect wake had exactly
    /// that hole, and macOS does not reliably wake a parked accept(2) via
    /// shutdown(2) on the listener.
    wake: Option<UnixStream>,
    accept: Option<JoinHandle<()>>,
    /// Set by the accept loop if it dies ABNORMALLY (a broken poll). The
    /// door would otherwise look open while nothing accepts.
    dead: Arc<AtomicBool>,
    conns: Conns,
}

impl UnixDoor {
    /// Open a door at `path`, named `label` in its threads and log lines,
    /// handing every connection to `serve`.
    pub(crate) fn open(path: &Path, label: &'static str, serve: Serve) -> Result<UnixDoor, String> {
        let dir = prepare_socket_dir(path)?;
        // Own the NAME before touching it. bind(2) alone cannot arbitrate:
        // the stale-socket cleanup below UNLINKS the name first, so two
        // instances interleaving here would each remove the other's freshly
        // bound socket — and a close would then delete a live one. The
        // kernel frees this lock on process death, so a killed run leaves no
        // stale claim.
        let lock = File::create(dir.join(LOCK_FILE)).map_err(|e| e.to_string())?;
        claim(&lock, path)?;
        // Under the lock, "something is in the way" is decided by
        // symlink_metadata: `exists()` follows links, so a DANGLING symlink
        // at the socket path would read as absent and then wedge bind(2)
        // forever.
        if std::fs::symlink_metadata(path).is_ok() {
            // A connectable socket means a server we do not own is live on
            // this name (an older build, a foreign process) — refuse rather
            // than steal. Anything not answering is a killed run's leftover.
            if UnixStream::connect(path).is_ok() {
                return Err(format!("{} is already served by another process", path.display()));
            }
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        let listener = UnixListener::bind(path).map_err(|e| e.to_string())?;
        // Depth in defense only — the directory already gates access.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        let node = std::fs::metadata(path).map(|meta| (meta.dev(), meta.ino())).map_err(|e| e.to_string())?;
        // Non-blocking: poll(2) readiness is a hint, not a guarantee —
        // accept after POLLIN must never be able to park the loop where the
        // closing wake cannot reach it.
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;

        let (wake_rx, wake_tx) = UnixStream::pair().map_err(|e| e.to_string())?;
        let dead = Arc::new(AtomicBool::new(false));
        let conns = Conns::default();
        let accept = {
            let conns = conns.clone();
            let dead = dead.clone();
            std::thread::Builder::new()
                .name(format!("keepdeck {label} accept"))
                .spawn(move || accept::serve(listener, wake_rx, label, serve, conns, dead))
                .map_err(|e| e.to_string())?
        };
        Ok(UnixDoor { path: path.to_path_buf(), _lock: lock, node, wake: Some(wake_tx), accept: Some(accept), dead, conns })
    }

    /// The path it is bound at.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Whether its accept loop died abnormally: the door looks open and
    /// nothing accepts.
    pub(crate) fn is_dead(&self) -> bool {
        self.dead.load(Ordering::SeqCst)
    }
}

impl Drop for UnixDoor {
    fn drop(&mut self) {
        // Dropping the wake handle EOFs the accept loop's poll — the wake
        // that works whether or not the socket file still exists.
        drop(self.wake.take());
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
        // Closed means DISCONNECTED, not merely unreachable: a half-open
        // client would otherwise sit on a dead pipe believing it is still
        // served.
        let drained: Vec<UnixStream> = {
            let mut conns = self.conns.lock().expect("door conns poisoned");
            conns.drain().map(|(_, conn)| conn).collect()
        };
        for conn in drained {
            let _ = conn.shutdown(std::net::Shutdown::Both);
        }
        // Unlink the name only while it still resolves to the socket THIS
        // door bound. The lock makes another instance's claim impossible
        // while we hold it, but a name that has moved on (an external rm, a
        // future path change) must never be deleted on someone else's
        // behalf.
        let ours = std::fs::metadata(&self.path).map(|meta| (meta.dev(), meta.ino()) == self.node).unwrap_or(false);
        if ours {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A scratch directory THIS call created — the create is the claim, so
    /// a leftover from an earlier run (pids are recycled, and nothing here
    /// sweeps /tmp) can never be handed to a test as if it were fresh.
    /// Names stay short: unix socket paths cap at ~104 bytes on macOS.
    fn temp_root() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        loop {
            let dir = std::env::temp_dir().join(format!("kd-door-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
            if std::fs::create_dir(&dir).is_ok() {
                return dir;
            }
        }
    }

    /// A socket directory that does NOT exist yet, inside a fresh root.
    pub(crate) fn temp_base() -> PathBuf {
        temp_root().join("door")
    }

    /// A fresh socket path whose directory already exists.
    pub(crate) fn temp_sock() -> PathBuf {
        let dir = temp_base();
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join("door.sock")
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::temp_sock;
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::time::Duration;

    /// Answers each line with the same line in upper case.
    fn upper() -> Serve {
        Arc::new(|stream: UnixStream, _| {
            let Ok(mut writer) = stream.try_clone() else { return };
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                if writeln!(writer, "{}", line.to_uppercase()).is_err() {
                    break;
                }
            }
        })
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
    fn serves_connections_through_its_serve_with_owner_only_perms() {
        let path = temp_sock();
        let door = UnixDoor::open(&path, "test", upper()).expect("open");
        let mode = std::fs::metadata(&path).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        // The directory is the load-bearing permission: 0700 even if it
        // pre-existed looser (open enforces, not just creates).
        let dir_mode = std::fs::metadata(path.parent().expect("parent")).expect("dir metadata").permissions().mode();
        assert_eq!(dir_mode & 0o777, 0o700);
        assert_eq!(roundtrip(&path, "hello"), "HELLO");
        assert_eq!(door.path(), path);
    }

    #[test]
    fn a_connection_is_handed_the_process_on_its_far_end() {
        // The pane check rests on this pid being the CLIENT's: a client in
        // this test process is the one case where it is known.
        let path = temp_sock();
        let (seen, heard) = std::sync::mpsc::channel();
        let door = UnixDoor::open(
            &path,
            "test",
            Arc::new(move |_, peer| {
                let _ = seen.send(peer);
            }),
        )
        .expect("open");
        let _client = UnixStream::connect(&path).expect("connect");
        let peer = heard.recv_timeout(Duration::from_secs(5)).expect("served");
        let expected = cfg!(any(target_os = "macos", target_os = "linux")).then(std::process::id);
        assert_eq!(peer, expected);
        drop(door);
    }

    #[test]
    fn a_connection_drops_its_teardown_handle_when_it_is_served() {
        // The handle map is what closing cuts; a finished connection that
        // left its entry behind would have every close cutting a dead stream.
        let path = temp_sock();
        let (served, heard) = std::sync::mpsc::channel();
        let door = UnixDoor::open(
            &path,
            "test",
            Arc::new(move |_, _| {
                let _ = served.send(());
            }),
        )
        .expect("open");
        let _client = UnixStream::connect(&path).expect("connect");
        // The handle is taken before the connection is served.
        heard.recv_timeout(Duration::from_secs(5)).expect("served");
        for _ in 0..2000 {
            if door.conns.lock().unwrap().is_empty() {
                return;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        panic!("the connection kept its teardown handle after it was served");
    }

    #[test]
    fn a_dangling_symlink_at_the_socket_path_is_cleared() {
        // `exists()` follows links, so a dangling one reads as absent and
        // then wedges bind(2) forever — the staleness check must not.
        let path = temp_sock();
        std::os::unix::fs::symlink(path.with_extension("gone"), &path).expect("symlink");
        let _door = UnixDoor::open(&path, "test", upper()).expect("open over a dangling symlink");
        assert_eq!(roundtrip(&path, "up"), "UP");
    }

    #[test]
    fn the_name_stays_owned_even_when_the_socket_file_vanishes() {
        // Closing UNLINKS the name, and the stale-file cleanup unlinks it
        // too — so without an owner's claim a second door could bind over a
        // live one and later delete its socket. The claim outlives the file:
        // only the owning door going away frees the name.
        let path = temp_sock();
        let first = UnixDoor::open(&path, "test", upper()).expect("first");
        std::fs::remove_file(&path).expect("the file vanishes");
        assert!(UnixDoor::open(&path, "test", upper()).is_err(), "the name must stay owned while its door lives");
        drop(first);
        // Owner gone → the name is free again. Not necessarily INSTANTLY:
        // a claim survives in any process that forked while we held it,
        // until that child execs — which is what `claim`'s wait covers.
        let second = UnixDoor::open(&path, "test", upper());
        assert!(second.is_ok(), "the name must be free once its owner closed: {:?}", second.err());
    }

    #[test]
    fn a_claim_held_only_in_passing_does_not_refuse_a_reopen() {
        // The whole open path, not just `claim`: a page reload's disable
        // then enable lands in the window where a forked child still holds
        // the released claim, and must not be told another instance owns
        // the socket.
        let path = temp_sock();
        let holder = File::create(path.parent().unwrap().join(LOCK_FILE)).expect("lock file");
        holder.try_lock().expect("hold the claim");
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            drop(holder);
        });
        let opened = UnixDoor::open(&path, "test", upper());
        assert!(opened.is_ok(), "a claim held in passing must not refuse a reopen: {:?}", opened.err());
    }

    #[test]
    fn closing_leaves_a_socket_it_no_longer_owns_alone() {
        let path = temp_sock();
        let door = UnixDoor::open(&path, "test", upper()).expect("open");
        // The name moves on to a different inode (an external rm plus
        // whatever took its place). Deleting THAT would be deleting on
        // someone else's behalf.
        std::fs::remove_file(&path).expect("rm");
        std::fs::write(&path, b"not ours").expect("replace");
        drop(door);
        assert!(path.exists(), "a foreign file at the name must survive the close");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn replaces_a_stale_socket_file() {
        let path = temp_sock();
        // A killed run's leftover: a path nothing answers on. A plain file
        // exercises the same branch — exists, but connect fails.
        std::fs::write(&path, b"").expect("stale file");
        let _door = UnixDoor::open(&path, "test", upper()).expect("open over stale");
        assert_eq!(roundtrip(&path, "up"), "UP");
    }

    #[test]
    fn refuses_a_socket_another_door_holds() {
        let path = temp_sock();
        let _first = UnixDoor::open(&path, "test", upper()).expect("first");
        assert!(UnixDoor::open(&path, "test", upper()).is_err(), "a live socket must not be stolen");
        // The refusal must not have torn down the live door either.
        assert_eq!(roundtrip(&path, "still"), "STILL");
    }

    #[test]
    fn closing_cuts_its_connections_and_removes_the_socket() {
        let path = temp_sock();
        let door = UnixDoor::open(&path, "test", upper()).expect("open");
        let stream = UnixStream::connect(&path).expect("connect");
        let mut reader = BufReader::new(stream);
        // Served, so the connection is one the door holds a handle on.
        let mut writer = reader.get_ref().try_clone().expect("clone");
        writeln!(writer, "served").expect("write");
        let mut first = String::new();
        reader.read_line(&mut first).expect("read");

        drop(door);

        // The blocked read must END (EOF or reset) — a client left believing
        // it is connected is exactly what a close must not produce.
        let mut buf = String::new();
        let read = reader.read_line(&mut buf);
        assert!(matches!(read, Ok(0)) || read.is_err());
        assert!(!path.exists(), "a closed door leaves no socket file behind");
    }

    #[test]
    fn closing_completes_even_after_the_socket_file_was_deleted() {
        let path = temp_sock();
        let door = UnixDoor::open(&path, "test", upper()).expect("open");
        std::fs::remove_file(&path).expect("delete the file out from under the door");
        // A wake that depends on the file (self-connect) hangs here forever;
        // the poll-channel wake must not.
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            drop(door);
            let _ = done_tx.send(());
        });
        done_rx.recv_timeout(Duration::from_secs(5)).expect("close wedged — the accept loop was never woken");
        worker.join().unwrap();
    }
}
