//! A bound port and the loop that accepts on it.
//!
//! Everything here is true of any local surface: bind to an ephemeral port
//! on loopback, poll for either a connection or the teardown signal, hand
//! each accepted socket to whoever registered for it, and die exactly once.
//! What arrives on the socket, and what it means, is the consumer's business
//! — this loop never reads a byte.
//!
//! The teardown pair is the whole reason `poll` is here rather than a
//! blocking accept: a listener with no second fd to watch can only be woken
//! by a connection, so stopping one means connecting to it, which races
//! anything else dialling the same port. The NEAR end is held for the
//! listener's life; dropping it is the wake.

use std::net::{TcpListener, TcpStream};

use crate::http::{read_request, respond_empty, request::Request};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long to wait before retrying after an accept error, so a storm of
/// failures cannot spin the CPU.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
/// Consecutive accept failures that mean the listener is not coming back.
const ACCEPT_FAILURE_LIMIT: u32 = 10;

struct Shared {
    dead: AtomicBool,
    /// The teardown wake pair. The NEAR end is HELD for the listener's life
    /// — dropping it at `start`'s return would give the loop instant EOF and
    /// exit it immediately; the far end is what the loop polls.
    wake_keep: Mutex<Option<UnixStream>>,
    wake_poll: Mutex<Option<UnixStream>>,
    /// Names this listener in its log lines. A shared loop that said
    /// "artifacts" would be a shared loop that knew one consumer.
    label: &'static str,
}

/// A bound port, before anything accepts on it.
///
/// The port travels OUT with this value and is not kept by the listener:
/// the consumer builds its state around the number, and a second copy here
/// would be a second place for it to be wrong.
///
/// Binding is separate from serving because a consumer usually needs its own
/// port to build the state the handler will read — the artifacts surface puts
/// it in every URL it composes — and a handler cannot be written before the
/// state it closes over exists.
pub(crate) struct Bound {
    listener: TcpListener,
    pub(crate) port: u16,
}

/// Take an ephemeral port on loopback. Ephemeral on purpose: a fixed number
/// is a number two instances can fight over, and nothing here is discovered
/// by guessing — the address is published to whoever needs it.
pub(crate) fn bind(label: &str) -> Result<Bound, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("binding the {label} listener failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("nonblocking listener: {e}"))?;
    Ok(Bound { listener, port })
}

pub(crate) struct Listener {
    shared: Arc<Shared>,
    accept: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Listener {
    /// Start accepting on a bound port.
    ///
    /// The head is read HERE, once, for every consumer: a request that never
    /// parses is answered with its status and never reaches a route table,
    /// so no surface has to own that failure twice. What the request MEANS
    /// stays with the consumer — this loop matches nothing.
    ///
    /// The handler takes the connection whole because the SSE case keeps its
    /// socket alive past the call; handing over a borrow would be a lie
    /// about who owns it.
    pub(crate) fn serve<H>(
        bound: Bound,
        label: &'static str,
        handler: H,
    ) -> Result<Self, String>
    where
        H: Fn(TcpStream, Request) + Send + Sync + 'static,
    {
        let Bound { listener, .. } = bound;
        let (wake_near, wake_far) =
            UnixStream::pair().map_err(|e| format!("wake pair: {e}"))?;
        let shared = Arc::new(Shared {
            dead: AtomicBool::new(false),
            wake_keep: Mutex::new(Some(wake_near)),
            wake_poll: Mutex::new(Some(wake_far)),
            label,
        });
        let loop_shared = Arc::clone(&shared);
        let accept = std::thread::Builder::new()
            .name(format!("keepdeck {label} accept"))
            .spawn(move || accept_loop(listener, loop_shared, handler))
            .map_err(|e| format!("spawning the {label} accept loop failed: {e}"))?;
        Ok(Self {
            shared,
            accept: Mutex::new(Some(accept)),
        })
    }

    pub(crate) fn is_alive(&self) -> bool {
        !self.shared.dead.load(Ordering::SeqCst)
    }

    /// Mark dead, wake the loop, and WAIT for it. Joining is what makes the
    /// port free by the time this returns — a caller that stops a listener
    /// in order to start another one has no other way to know.
    ///
    /// ONLY the near end is dropped. The far end has to outlive the wake:
    /// the loop re-reads its fd every iteration, and a loop that finds the
    /// far end already taken polls `-1` — which is not an error, it is a
    /// wait on the listening socket alone, with no timeout and no
    /// connection ever coming. Dropping both used to leak that thread
    /// quietly; joining turns the same race into a hang, which is how it
    /// was found. The far end dies with `Shared`.
    pub(crate) fn stop(&self) {
        self.shared.dead.store(true, Ordering::SeqCst);
        drop(self.shared.wake_keep.lock().expect("wake poisoned").take());
        if let Some(handle) = self.accept.lock().expect("accept poisoned").take() {
            let _ = handle.join();
        }
    }
}

fn accept_loop<H>(listener: TcpListener, shared: Arc<Shared>, handler: H)
where
    H: Fn(TcpStream, Request) + Send + Sync + 'static,
{
    use std::os::fd::AsRawFd as _;
    let label = shared.label;
    let handler = Arc::new(handler);
    let mut failures = 0u32;
    loop {
        // stop() may race a poll iteration: this check is the exit when the
        // wake pair is already dropped (fd -1 ignored below).
        if shared.dead.load(Ordering::SeqCst) {
            return;
        }
        let mut fds = [
            libc::pollfd {
                fd: listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: shared
                    .wake_poll
                    .lock()
                    .expect("wake poisoned")
                    .as_ref()
                    .map(|w| w.as_raw_fd())
                    .unwrap_or(-1),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, -1) };
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            log::warn!("{label}: poll failed, accept loop exiting: {error}");
            shared.dead.store(true, Ordering::SeqCst);
            return;
        }
        if fds[1].revents != 0 {
            // Teardown wins over a pending connection.
            return;
        }
        if fds[0].revents == 0 {
            continue;
        }
        let Ok((stream, _)) = listener.accept() else {
            failures += 1;
            if failures >= ACCEPT_FAILURE_LIMIT {
                log::error!("{label}: accept failed {failures} times, loop dead");
                shared.dead.store(true, Ordering::SeqCst);
                return;
            }
            log::warn!("{label}: accept failed, backing off");
            std::thread::sleep(ACCEPT_BACKOFF);
            continue;
        };
        failures = 0;
        let _ = stream.set_nonblocking(false);
        let handler = Arc::clone(&handler);
        let spawned = std::thread::Builder::new()
            .name(format!("keepdeck {label} conn"))
            .spawn(move || {
                let mut stream = stream;
                match read_request(&mut stream) {
                    Ok(request) => handler(stream, request),
                    Err(status) => {
                        let _ = respond_empty(&mut stream, status);
                    }
                }
            });
        if let Err(e) = spawned {
            log::warn!("{label}: dropping connection, no thread: {e}");
        }
    }
}
