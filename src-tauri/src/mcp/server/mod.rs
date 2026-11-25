//! The MCP transport's socket — its On/Off and its lines.
//!
//! The command registry's external transport listens on ONE unix socket at
//! `<keepdeck_home>/mcp/mcp.sock`, a [`UnixDoor`]. This module owns when that
//! door is open: the webview's MCP service maps 1:1 onto
//! [`McpServer::enable`] / [`McpServer::disable`] — up means "the file exists
//! and accepts connections", down means "the file is gone and every client
//! was disconnected" — while the app keeps running (a page reload is one
//! disable and one enable).
//!
//! What travels over a connection is one JSON line per message (the MCP stdio
//! framing, verbatim — the bundled shim forwards bytes untouched). Each line
//! is answered by the injected [`LineHandler`], so this module knows nothing
//! about MCP itself: the webview bridge owns semantics, and the lifecycle
//! stays testable with a plain echo handler.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::unix_door::{Serve, UnixDoor};

/// Answers one request line with AT MOST one reply line — `None` for
/// JSON-RPC notifications, which must never be answered.
pub(crate) type ConnectionHandler = Box<dyn FnMut(&str) -> Option<String> + Send>;

/// Makes one handler per CONNECTION. Per connection, not per socket, because
/// a client may introduce ITSELF on the wire (see the `deck/client` preamble
/// in [`crate::mcp::bridge`]) and what it said belongs to that connection
/// alone. It is handed the connecting process, as the kernel names it; None
/// when it could not be told. The factory itself is shared across the
/// door's threads.
pub(crate) type LineHandler = Arc<dyn Fn(Option<u32>) -> ConnectionHandler + Send + Sync>;

/// Managed state: the socket's door, open while a webview holds it up.
#[derive(Default)]
pub struct McpServer {
    inner: Mutex<Option<UnixDoor>>,
}

impl McpServer {
    /// Bring the socket up at `path`. Idempotent: enabling while running IS
    /// the state the caller asked for, so it reports the existing socket.
    pub(crate) fn enable(&self, path: &Path, handler: LineHandler) -> Result<PathBuf, String> {
        let mut inner = self.inner.lock().expect("mcp server poisoned");
        if let Some(door) = inner.as_ref() {
            if !door.is_dead() {
                return Ok(door.path().to_path_buf());
            }
            // The accept loop died abnormally — idempotence must not hand
            // back a corpse. Close the remains (the join returns at once, the
            // thread is gone) and open afresh.
            log::warn!("mcp: accept loop had died — restarting the socket");
            drop(inner.take());
        }
        let door = UnixDoor::open(path, "mcp", lines(handler))?;
        let served = door.path().to_path_buf();
        *inner = Some(door);
        Ok(served)
    }

    /// Tear the socket down: stop accepting, disconnect every client, remove
    /// the file. Idempotent — Off while off is a no-op, not an error.
    ///
    /// The lock is held across the WHOLE close (safe: no other thread takes
    /// it — the door's threads never touch this mutex). Released mid-way, a
    /// concurrent enable could bind a fresh socket that the tail of this
    /// close then unlinks — On with no file to connect to.
    pub(crate) fn disable(&self) {
        let mut inner = self.inner.lock().expect("mcp server poisoned");
        drop(inner.take());
    }
}

/// One connection of the MCP door: read a line, answer at most a line, until
/// the client leaves, a write fails, or the door is closed under it.
fn lines(handler: LineHandler) -> Serve {
    Arc::new(move |stream: UnixStream, peer| {
        let Ok(mut writer) = stream.try_clone() else { return };
        // This connection's own handler: what the client says about itself
        // must not leak into anyone else's requests.
        let mut answer = handler(peer);
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::unix_door::test_support::temp_sock;

    fn upper() -> LineHandler {
        Arc::new(|_| Box::new(|line: &str| Some(line.to_uppercase())))
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

    /// Serve one connection of `handler` on a socketpair, as the door would,
    /// with no peer; the client end comes back.
    fn connected(handler: LineHandler) -> UnixStream {
        let (client, served) = UnixStream::pair().expect("socketpair");
        let serve = lines(handler);
        std::thread::spawn(move || serve(served, None));
        client
    }

    #[test]
    fn a_none_reply_writes_nothing_and_keeps_the_connection() {
        // Notification-style lines (here: a '!' prefix) produce no reply;
        // the NEXT request's reply must be the first thing the client reads.
        let client = connected(Arc::new(|_| Box::new(|line: &str| (!line.starts_with('!')).then(|| line.to_uppercase()))));
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
        let handler: LineHandler = Arc::new(|_| {
            let mut seen = 0u32;
            Box::new(move |_line: &str| {
                seen += 1;
                Some(seen.to_string())
            })
        });
        let mut replies = Vec::new();
        for _ in 0..2 {
            let client = connected(handler.clone());
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
    fn re_enable_serves_again_and_enable_is_idempotent() {
        let path = temp_sock();
        let server = McpServer::default();
        server.enable(&path, upper()).expect("enable");
        server.disable();
        let served = server.enable(&path, upper()).expect("re-enable");
        assert_eq!(served, path);
        // A second enable reports the running socket instead of failing —
        // an enable asserts a state, it is not an action counter.
        let again = server.enable(&path, upper()).expect("enable while on");
        assert_eq!(again, path);
        assert_eq!(roundtrip(&path, "back"), "BACK");
        server.disable();
    }
}
