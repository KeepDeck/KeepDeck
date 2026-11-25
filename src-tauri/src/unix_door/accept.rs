//! The accept loop and the per-connection threads it starts.
//!
//! The loop parks in `poll(2)` rather than in `accept(2)`: the only reliable
//! way out of a parked accept is a connection, and closing cannot make one
//! once the socket file is gone. So it watches two descriptors — the listener
//! and a wake channel whose far end closing drops — and a close wins over a
//! pending connection.

use std::net::Shutdown;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::{Conns, Serve};

/// How long the loop waits out a transient accept failure (fd exhaustion),
/// and how many consecutive failures it tolerates before declaring the
/// socket dead instead of retrying at 10Hz forever.
const ACCEPT_FAILURE_BACKOFF: Duration = Duration::from_millis(100);
const ACCEPT_FAILURE_LIMIT: u32 = 10;

/// Serve connections until closing drops `wake` (or the loop dies, which it
/// records in `dead` so whoever holds the door can tell it from an open one).
pub(super) fn serve(
    listener: UnixListener,
    wake: UnixStream,
    label: &'static str,
    handler: Serve,
    conns: Conns,
    dead: Arc<AtomicBool>,
) {
    let mut next_id = 0u64;
    let mut failures = 0u32;
    loop {
        match poll_verdict(&listener, &wake, label) {
            PollVerdict::Teardown => break,
            PollVerdict::Broken => {
                // Visible death, not a silent one: the flag lets whoever
                // holds the door reopen it instead of reporting a corpse.
                dead.store(true, Ordering::SeqCst);
                break;
            }
            PollVerdict::Accept => {}
        }
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) => {
                // fd exhaustion and kin: the pending connection stays
                // queued, so poll re-fires immediately — back off instead of
                // spinning a core. A fault that never clears must not back
                // off FOREVER, logging every 100ms into a capped log budget:
                // give up, and let the flag report the death.
                failures += 1;
                if failures >= ACCEPT_FAILURE_LIMIT {
                    log::error!("{label}: accept failed {failures} times, socket dead: {e}");
                    dead.store(true, Ordering::SeqCst);
                    break;
                }
                log::warn!("{label}: accept failed: {e}");
                std::thread::sleep(ACCEPT_FAILURE_BACKOFF);
                continue;
            }
        };
        failures = 0;
        // Connection I/O is blocking — undo the listener's inherited
        // non-blocking mode.
        if stream.set_nonblocking(false).is_err() {
            continue;
        }
        next_id += 1;
        // No teardown handle, no service: a connection a close could not
        // cut would outlive the door and keep driving the deck — the one
        // promise this module makes.
        match stream.try_clone() {
            Ok(clone) => {
                conns.lock().expect("door conns poisoned").insert(next_id, clone);
                if let Err(e) = spawn_connection(next_id, stream, label, handler.clone(), conns.clone()) {
                    // No thread, no service — and the teardown clone must
                    // not keep the doomed connection open past this refusal.
                    log::warn!("{label}: dropping connection, no thread: {e}");
                    if let Some(conn) = conns.lock().expect("door conns poisoned").remove(&next_id) {
                        let _ = conn.shutdown(Shutdown::Both);
                    }
                }
            }
            Err(e) => {
                log::warn!("{label}: dropping connection, no teardown handle: {e}");
            }
        }
    }
}

enum PollVerdict {
    /// The listener has a pending connection.
    Accept,
    /// The wake channel's far end was dropped — the door is closing.
    Teardown,
    /// poll(2) itself failed (not EINTR) — the loop cannot serve on.
    Broken,
}

/// Park until the listener is readable or closing wakes us.
fn poll_verdict(listener: &UnixListener, wake: &UnixStream, label: &str) -> PollVerdict {
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
            log::warn!("{label}: poll failed, socket dead: {error}");
            return PollVerdict::Broken;
        }
        // Closing wins over a pending connection.
        if fds[1].revents != 0 {
            return PollVerdict::Teardown;
        }
        if fds[0].revents != 0 {
            return PollVerdict::Accept;
        }
    }
}

/// One thread per connection: the door's `serve`, handed the connection and
/// its peer. When it returns — the client left, a write failed, or closing
/// shut the stream down — the connection removes its own teardown handle.
/// The spawn error propagates: the caller must un-register the connection it
/// pre-registered.
fn spawn_connection(id: u64, stream: UnixStream, label: &str, handler: Serve, conns: Conns) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name(format!("keepdeck {label} conn"))
        .spawn(move || {
            let peer = peer_pid(&stream);
            handler(stream, peer);
            conns.lock().expect("door conns poisoned").remove(&id);
        })
        .map(|_| ())
}

/// The process on the other end of `stream`, as the kernel recorded it at
/// connect. None when it cannot be told.
fn peer_pid(stream: &UnixStream) -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        let mut pid: libc::pid_t = 0;
        let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        // SAFETY: LOCAL_PEERPID writes one pid_t into a buffer of that size.
        let read = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                (&mut pid as *mut libc::pid_t).cast(),
                &mut len,
            )
        };
        (read == 0 && pid > 0).then_some(pid as u32)
    }
    #[cfg(target_os = "linux")]
    {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: SO_PEERCRED writes one ucred into a buffer of that size.
        let read = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut cred as *mut libc::ucred).cast(),
                &mut len,
            )
        };
        (read == 0 && cred.pid > 0).then_some(cred.pid as u32)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = stream;
        None
    }
}
