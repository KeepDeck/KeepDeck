//! The MCP transport's socket — lifecycle only.
//!
//! The command registry's external transport listens on ONE unix socket at
//! `<keepdeck_home>/mcp.sock`. This module owns that socket's life: the
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
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tauri::State;

/// Answers one request line with AT MOST one reply line — `None` for
/// JSON-RPC notifications, which must never be answered. Shared by every
/// connection thread, so it must be `Send + Sync` and safe to call
/// concurrently.
pub type LineHandler = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Managed state: the socket server, present while the toggle is on.
#[derive(Default)]
pub struct McpServer {
    inner: Mutex<Option<Running>>,
}

struct Running {
    path: PathBuf,
    shutdown: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
    /// Teardown handles: a clone per live connection, so Off can actively
    /// disconnect clients instead of leaving them on a dead pipe.
    conns: Arc<Mutex<HashMap<u64, UnixStream>>>,
}

impl McpServer {
    /// Bring the socket up at `path`. Idempotent: enabling while running IS
    /// the state the caller asked for, so it reports the existing socket.
    pub fn enable(&self, path: &Path, handler: LineHandler) -> Result<PathBuf, String> {
        let mut inner = self.inner.lock().expect("mcp server poisoned");
        if let Some(running) = inner.as_ref() {
            return Ok(running.path.clone());
        }
        let running = start_at(path, handler)?;
        let served = running.path.clone();
        *inner = Some(running);
        Ok(served)
    }

    /// Tear the socket down: stop accepting, disconnect every client, remove
    /// the file. Idempotent — Off while off is a no-op, not an error.
    pub fn disable(&self) {
        let running = self.inner.lock().expect("mcp server poisoned").take();
        if let Some(running) = running {
            stop(running);
        }
    }
}

fn start_at(path: &Path, handler: LineHandler) -> Result<Running, String> {
    if path.exists() {
        // A connectable socket is a LIVE server — most likely a second app
        // instance sharing this home. Stealing its name would silently break
        // its clients, so refuse; anything not answering is a leftover from
        // a killed run and is cleared.
        if UnixStream::connect(path).is_ok() {
            return Err(format!(
                "{} is already served by another process",
                path.display()
            ));
        }
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let listener = UnixListener::bind(path).map_err(|e| e.to_string())?;
    // Owner-only, set before anyone could race a connection in: the file IS
    // the permission model — any process that can open it can drive the deck.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let conns: Arc<Mutex<HashMap<u64, UnixStream>>> = Arc::default();
    let accept = {
        let shutdown = shutdown.clone();
        let conns = conns.clone();
        std::thread::Builder::new()
            .name("keepdeck mcp accept".into())
            .spawn(move || {
                let mut next_id = 0u64;
                for stream in listener.incoming() {
                    // The flag is only observable after an accept returns, so
                    // `stop` hands the loop one final connection to chew on.
                    if shutdown.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    next_id += 1;
                    if let Ok(clone) = stream.try_clone() {
                        conns
                            .lock()
                            .expect("mcp conns poisoned")
                            .insert(next_id, clone);
                    }
                    spawn_connection(next_id, stream, handler.clone(), conns.clone());
                }
            })
            .map_err(|e| e.to_string())?
    };

    Ok(Running {
        path: path.to_path_buf(),
        shutdown,
        accept: Some(accept),
        conns,
    })
}

/// One thread per connection: read a line, answer a line. Ends on client
/// EOF, on a write failure, or when `stop` shuts the stream down — and then
/// removes its own teardown handle.
fn spawn_connection(
    id: u64,
    stream: UnixStream,
    handler: LineHandler,
    conns: Arc<Mutex<HashMap<u64, UnixStream>>>,
) {
    let _ = std::thread::Builder::new()
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
        });
}

fn stop(mut running: Running) {
    running.shutdown.store(true, Ordering::SeqCst);
    // Unblock the accept loop (see the flag note there). The socket file must
    // still exist at this point, so removal comes after the join.
    let _ = UnixStream::connect(&running.path);
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
    let _ = std::fs::remove_file(&running.path);
}

/// The socket path for this build's home. A missing home means no
/// persistence environment at all — the transport refuses to run rather than
/// invent a location.
fn socket_path() -> Result<PathBuf, String> {
    crate::paths::keepdeck_home()
        .map(|home| home.join("mcp.sock"))
        .ok_or_else(|| "no home directory to hold the MCP socket".to_string())
}

#[tauri::command(async)]
pub fn mcp_enable(app: tauri::AppHandle, server: State<McpServer>) -> Result<String, String> {
    let path = socket_path()?;
    let served = server.enable(&path, crate::mcp_bridge::webview_handler(app))?;
    log::info!("mcp: socket up at {}", served.display());
    Ok(served.display().to_string())
}

#[tauri::command(async)]
pub fn mcp_disable(server: State<McpServer>) {
    server.disable();
    log::info!("mcp: socket down");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn upper() -> LineHandler {
        Arc::new(|line: &str| Some(line.to_uppercase()))
    }

    /// A fresh socket path in a per-test temp dir (unix socket paths have a
    /// ~104-byte cap on macOS, so the dir name stays short).
    fn temp_sock() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kd-mcp-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
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
        assert_eq!(roundtrip(&path, "hello"), "HELLO");
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
