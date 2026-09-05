//! The accept loop and the per-connection threads it starts.
//!
//! The loop parks in `poll(2)` rather than in `accept(2)`: the only reliable
//! way out of a parked accept is a connection, and teardown cannot make one
//! once the socket file is gone. So it watches two descriptors — the listener
//! and a wake channel whose far end teardown drops — and Off wins over a
//! pending connection.

use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::{Conns, LineHandler};

/// How long the loop waits out a transient accept failure (fd exhaustion),
/// and how many consecutive failures it tolerates before declaring the
/// socket dead instead of retrying at 10Hz forever.
const ACCEPT_FAILURE_BACKOFF: Duration = Duration::from_millis(100);
const ACCEPT_FAILURE_LIMIT: u32 = 10;

/// Serve connections until teardown drops `wake` (or the loop dies, which it
/// records in `dead` so the next enable restarts instead of reporting a
/// corpse as running).
pub(super) fn serve(
    listener: UnixListener,
    wake: UnixStream,
    handler: LineHandler,
    conns: Conns,
    dead: Arc<AtomicBool>,
) {
    let mut next_id = 0u64;
    let mut failures = 0u32;
    loop {
        match poll_verdict(&listener, &wake) {
            PollVerdict::Teardown => break,
            PollVerdict::Broken => {
                // Visible death, not a silent one: the flag makes the next
                // enable restart instead of reporting a corpse as running.
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
        // Connection I/O is blocking (BufReader::lines) — undo the
        // listener's inherited non-blocking mode.
        if stream.set_nonblocking(false).is_err() {
            continue;
        }
        next_id += 1;
        // No teardown handle, no service: a connection a disable could not
        // disconnect would outlive the server and keep driving the deck —
        // the one promise this module makes.
        match stream.try_clone() {
            Ok(clone) => {
                conns
                    .lock()
                    .expect("mcp conns poisoned")
                    .insert(next_id, clone);
                if let Err(e) = spawn_connection(next_id, stream, handler.clone(), conns.clone()) {
                    // No thread, no service — and the teardown clone must
                    // not keep the doomed connection open past this refusal.
                    log::warn!("mcp: dropping connection, no thread: {e}");
                    if let Some(conn) = conns.lock().expect("mcp conns poisoned").remove(&next_id) {
                        let _ = conn.shutdown(Shutdown::Both);
                    }
                }
            }
            Err(e) => {
                log::warn!("mcp: dropping connection, no teardown handle: {e}");
            }
        }
    }
}

enum PollVerdict {
    /// The listener has a pending connection.
    Accept,
    /// The wake channel's far end was dropped — orderly teardown.
    Teardown,
    /// poll(2) itself failed (not EINTR) — the loop cannot serve on.
    Broken,
}

/// Park until the listener is readable or teardown wakes us.
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
/// client EOF, on a write failure, or when teardown shuts the stream down —
/// and then removes its own teardown handle. The spawn error propagates:
/// the caller must un-register the connection it pre-registered.
fn spawn_connection(
    id: u64,
    stream: UnixStream,
    handler: LineHandler,
    conns: Conns,
) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("keepdeck mcp conn".into())
        .spawn(move || {
            let Ok(mut writer) = stream.try_clone() else {
                conns.lock().expect("mcp conns poisoned").remove(&id);
                return;
            };
            // This connection's own handler: what the client says about
            // itself must not leak into anyone else's requests.
            let mut answer = handler();
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                if let Some(reply) = answer(&line) {
                    if writeln!(writer, "{reply}").is_err() {
                        break;
                    }
                }
            }
            conns.lock().expect("mcp conns poisoned").remove(&id);
        })
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_none_reply_writes_nothing_and_keeps_the_connection() {
        // Notification-style lines (here: a '!' prefix) produce no reply;
        // the NEXT request's reply must be the first thing the client reads.
        let handler: LineHandler =
            Arc::new(|| Box::new(|line: &str| (!line.starts_with('!')).then(|| line.to_uppercase())));
        let (client, served) = UnixStream::pair().expect("socketpair");
        let conns = Conns::default();
        spawn_connection(1, served, handler, conns.clone()).expect("spawn");

        let mut writer = client.try_clone().expect("clone");
        let mut reader = BufReader::new(client);
        writeln!(writer, "!notify").expect("write");
        writeln!(writer, "request").expect("write");
        let mut reply = String::new();
        reader.read_line(&mut reply).expect("read");
        assert_eq!(reply.trim_end(), "REQUEST");
    }

    #[test]
    fn each_connection_gets_its_own_handler() {
        // What a client says about ITSELF (the `deck/client` preamble) is
        // remembered by its handler, so two connections sharing one would
        // answer for each other.
        let handler: LineHandler = Arc::new(|| {
            let mut seen = 0u32;
            Box::new(move |_line: &str| {
                seen += 1;
                Some(seen.to_string())
            })
        });
        let conns = Conns::default();
        let mut replies = Vec::new();
        for _ in 0..2 {
            let (client, served) = UnixStream::pair().expect("socketpair");
            spawn_connection(1, served, handler.clone(), conns.clone()).expect("spawn");
            let mut writer = client.try_clone().expect("clone");
            let mut reader = BufReader::new(client);
            writeln!(writer, "first").expect("write");
            let mut reply = String::new();
            reader.read_line(&mut reply).expect("read");
            replies.push(reply.trim_end().to_string());
        }
        // Both connections are on their FIRST line, so both answer "1".
        assert_eq!(replies, vec!["1", "1"]);
    }

    #[test]
    fn a_connection_drops_its_teardown_handle_when_the_client_leaves() {
        // The handle map is what Off shuts down; a finished connection that
        // left its entry behind would have Off shutting down a dead stream
        // forever after.
        let handler: LineHandler = Arc::new(|| Box::new(|line: &str| Some(line.to_uppercase())));
        let (client, served) = UnixStream::pair().expect("socketpair");
        let conns = Conns::default();
        conns
            .lock()
            .unwrap()
            .insert(7, served.try_clone().expect("clone"));
        spawn_connection(7, served, handler, conns.clone()).expect("spawn");

        drop(client);
        for _ in 0..2000 {
            if conns.lock().unwrap().is_empty() {
                return;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        panic!("the connection kept its teardown handle after the client left");
    }
}
