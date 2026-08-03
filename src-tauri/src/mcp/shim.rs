//! `keepdeck --mcp-shim [socket]` — the stdio↔socket pump MCP clients spawn.
//!
//! MCP clients speak stdio to a spawned server process; KeepDeck's server
//! is the app's unix socket. The shim is the adapter between the two, and
//! it rides the app binary itself rather than shipping as a sidecar: main()
//! short-circuits here before Tauri boots, so there is nothing extra to
//! bundle or sign, the shim's version always matches the app's, and the
//! connect command points at a binary the install already placed.
//!
//! It is a byte pump, nothing more. Framing, protocol and errors all live
//! server-side; the pump's one protocol duty is a flush per chunk, because
//! a line-buffered stdout would sit on a reply and stall the client.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

/// The argv flag that turns the app binary into the shim. One home for the
/// string: the connect command the settings page hands out is built from
/// this same constant, so the producer and the parser cannot drift.
pub(crate) const SHIM_FLAG: &str = "--mcp-shim";

/// Names WHICH pane this shim was spawned for. One home for the string: the
/// connect invocation is built from this same constant, so producer and
/// parser cannot drift.
pub(crate) const CLIENT_FLAG: &str = "--client";

/// A parsed `--mcp-shim` invocation. `socket` overrides the default
/// `<keepdeck_home>/mcp/mcp.sock` — the connect command always passes it
/// explicitly (the client's environment may resolve a different home), and
/// it also serves test isolation and cross-flavor connects.
pub struct ShimMode {
    pub socket: Option<PathBuf>,
    /// The pane secret KeepDeck minted for this spawn, when the invocation
    /// was injected rather than written by hand. Announced once on connect
    /// (see [`run`]) and never used for anything else here — what it MEANS
    /// is the deck's to decide.
    pub client: Option<String>,
}

/// Detect the shim flag in argv (argv[0] is skipped — a binary named after
/// the flag is not an invocation of it); the value, when present, is the
/// argument right after it. A following token that looks like another flag
/// is NOT a socket path — swallowing it would point the "cannot connect"
/// hint at a socket literally named "--verbose". None means "boot the app
/// normally".
pub fn shim_mode(args: impl IntoIterator<Item = String>) -> Option<ShimMode> {
    let mut args = args.into_iter().skip(1);
    while let Some(arg) = args.next() {
        if arg == SHIM_FLAG {
            // The slot's value is CONSUMED before it is judged, so a flag
            // found there must be handed back to the scan below rather than
            // dropped: `--mcp-shim --client <secret>` used to eat the
            // `--client` token and leave the pane anonymous.
            let mut socket = None;
            let mut next = args.next();
            match next.as_deref() {
                Some(value) if !value.starts_with('-') => {
                    socket = next.take().map(PathBuf::from);
                }
                _ => {}
            }
            let mut client = None;
            let mut rest = next.into_iter().chain(args);
            while let Some(arg) = rest.next() {
                if arg == CLIENT_FLAG {
                    client = rest.next().filter(|value| !value.starts_with('-'));
                    break;
                }
            }
            return Some(ShimMode { socket, client });
        }
    }
    None
}

/// Run the pump to completion. Returns the process exit code: 0 once the
/// server closes the connection (toggle Off, app quit), non-zero when there
/// is nothing to connect to — with a hint, because "server not enabled" is
/// the overwhelmingly likely cause.
pub fn run(mode: ShimMode) -> i32 {
    let Some(path) = mode.socket.or_else(crate::paths::mcp_socket) else {
        eprintln!("keepdeck-mcp: no home directory and no socket argument");
        return 2;
    };
    let socket = match UnixStream::connect(&path) {
        Ok(socket) => socket,
        Err(e) => {
            eprintln!(
                "keepdeck-mcp: cannot connect to {} ({e}) — is the MCP server \
                 enabled in KeepDeck's settings?",
                path.display()
            );
            return 1;
        }
    };
    // Introduce ourselves before a single byte of the client's own traffic:
    // the deck binds the name to THIS connection, and a request that arrived
    // first would be attributed to nobody. A failure here is not fatal — an
    // anonymous session still works, it just cannot be told apart.
    if let Some(client) = mode.client {
        let announced = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "deck/client",
            "params": { "token": client },
        });
        let mut greeting = &socket;
        if let Err(e) = writeln!(greeting, "{announced}") {
            eprintln!("keepdeck-mcp: could not announce this pane ({e})");
        }
    }
    match pump(std::io::stdin(), &mut std::io::stdout(), socket) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("keepdeck-mcp: {e}");
            1
        }
    }
}

/// Copy `input` into the socket and the socket into `output` until the
/// server side closes. Input EOF (the client is done) half-closes the
/// socket so the server sees it; the uplink thread is deliberately NOT
/// joined — after the server closes, a client that keeps stdin open would
/// otherwise pin the process on a read that never returns. The process exit
/// reaps it.
fn pump<W: Write>(
    input: impl Read + Send + 'static,
    output: &mut W,
    socket: UnixStream,
) -> std::io::Result<()> {
    let mut uplink = socket.try_clone()?;
    std::thread::Builder::new()
        .name("keepdeck-mcp uplink".into())
        .spawn(move || {
            let mut input = input;
            let mut buf = [0u8; 8192];
            loop {
                match input.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if uplink.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
                    // A signal must not masquerade as client EOF — that
                    // would half-close a session mid-conversation.
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = uplink.shutdown(std::net::Shutdown::Write);
        })?;

    let mut downlink = socket;
    let mut buf = [0u8; 8192];
    loop {
        match downlink.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => {
                output.write_all(&buf[..n])?;
                output.flush()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn shim_mode_parses_flag_and_optional_socket() {
        assert!(shim_mode(args(&["keepdeck"])).is_none());
        let bare = shim_mode(args(&["keepdeck", "--mcp-shim"])).unwrap();
        assert_eq!(bare.socket, None);
        let with_path = shim_mode(args(&["keepdeck", "--mcp-shim", "/tmp/x.sock"])).unwrap();
        assert_eq!(with_path.socket, Some(PathBuf::from("/tmp/x.sock")));
    }

    #[test]
    fn shim_mode_reads_the_pane_secret_when_the_invocation_was_injected() {
        let injected = shim_mode(args(&[
            "keepdeck",
            "--mcp-shim",
            "/tmp/x.sock",
            "--client",
            "5f3c",
        ]))
        .unwrap();
        assert_eq!(injected.socket, Some(PathBuf::from("/tmp/x.sock")));
        assert_eq!(injected.client.as_deref(), Some("5f3c"));

        // The copy-pasteable command the settings page hands out carries no
        // secret, and such a session is simply anonymous.
        let by_hand = shim_mode(args(&["keepdeck", "--mcp-shim", "/tmp/x.sock"])).unwrap();
        assert_eq!(by_hand.client, None);

        // A flag where the secret should be is not a secret.
        let flagged =
            shim_mode(args(&["keepdeck", "--mcp-shim", "/tmp/x.sock", "--client", "--verbose"]))
                .unwrap();
        assert_eq!(flagged.client, None);
    }

    #[test]
    fn shim_mode_ignores_argv0_and_flag_like_socket_args() {
        // A binary named after the flag is not an invocation of it.
        assert!(shim_mode(args(&["--mcp-shim"])).is_none());
        // A following flag is not a socket path — the default must serve,
        // not a socket literally named "--verbose".
        let flagged = shim_mode(args(&["keepdeck", "--mcp-shim", "--verbose"])).unwrap();
        assert_eq!(flagged.socket, None);

        // And the token in that slot is handed BACK to the scan, not eaten:
        // the socket slot's value is consumed before it is judged, so
        // `--mcp-shim --client <secret>` used to lose the secret entirely and
        // leave every call from the pane journaled as anonymous.
        let kept =
            shim_mode(args(&["keepdeck", "--mcp-shim", "--client", "5f3c"])).unwrap();
        assert_eq!(kept.socket, None);
        assert_eq!(kept.client.as_deref(), Some("5f3c"));
    }

    /// A Write the pump can own while the test still reads it.
    #[derive(Clone, Default)]
    struct SharedBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A socket path in a directory THIS call created — the create is the
    /// claim, so a recycled pid can never hand a test an earlier run's
    /// leftovers (nothing here sweeps /tmp).
    fn temp_sock() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        loop {
            let dir = std::env::temp_dir().join(format!(
                "kd-shim-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            if std::fs::create_dir(&dir).is_ok() {
                return dir.join("mcp.sock");
            }
        }
    }

    #[test]
    fn shim_and_server_speak_end_to_end() {
        // The real server (mcp_server) and the real pump, joined by the real
        // socket: client EOF propagates through the shim to the server, whose
        // connection close ends the pump — the whole life of a session.
        let path = temp_sock();
        let handler: crate::mcp::server::LineHandler =
            std::sync::Arc::new(|| Box::new(|line: &str| Some(line.to_uppercase())));
        let server = crate::mcp::server::McpServer::default();
        server.enable(&path, handler).expect("server");

        let socket = UnixStream::connect(&path).expect("connect");
        let output = SharedBuf::default();
        pump(Cursor::new(b"hello\n".to_vec()), &mut output.clone(), socket).expect("pump");

        assert_eq!(output.0.lock().unwrap().as_slice(), b"HELLO\n");
        server.disable();
    }

    #[test]
    fn disabling_the_server_releases_a_connected_shim() {
        let path = temp_sock();
        let handler: crate::mcp::server::LineHandler =
            std::sync::Arc::new(|| Box::new(|line: &str| Some(line.to_uppercase())));
        let server = crate::mcp::server::McpServer::default();
        server.enable(&path, handler).expect("enable");

        // Stdin that never EOFs: the far end of a pair, kept open — the pump
        // must end because the SERVER went away, not because input ran dry.
        let (input, input_feed) = UnixStream::pair().expect("pair");
        let socket = UnixStream::connect(&path).expect("connect");
        let output = SharedBuf::default();
        let pumped = {
            let mut output = output.clone();
            std::thread::spawn(move || pump(input, &mut output, socket))
        };
        {
            let mut feed = &input_feed;
            writeln!(feed, "ping").expect("feed");
        }
        // Wait for the round-trip so the disable provably cuts a LIVE session.
        while output.0.lock().unwrap().is_empty() {
            std::thread::yield_now();
        }

        server.disable();

        pumped.join().unwrap().expect("pump ends cleanly");
        assert_eq!(output.0.lock().unwrap().as_slice(), b"PING\n");
        drop(input_feed);
    }

    #[test]
    fn an_interrupted_read_is_retried_not_read_as_end_of_input() {
        /// Yields EINTR once, then the payload, then EOF.
        struct Interrupting {
            step: u8,
        }
        impl Read for Interrupting {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.step += 1;
                match self.step {
                    1 => Err(std::io::Error::from(std::io::ErrorKind::Interrupted)),
                    2 => {
                        let payload = b"after the signal\n";
                        buf[..payload.len()].copy_from_slice(payload);
                        Ok(payload.len())
                    }
                    _ => Ok(0),
                }
            }
        }

        let (near, far) = UnixStream::pair().expect("socketpair");
        let server = std::thread::spawn(move || {
            let mut far = far;
            let mut received = Vec::new();
            far.read_to_end(&mut received).expect("read to EOF");
            received
        });
        // A signal must not masquerade as client EOF: treating it as one
        // would half-close the session and drop the line that follows.
        pump(Interrupting { step: 0 }, &mut Vec::new(), near).expect("pump");
        assert_eq!(server.join().unwrap(), b"after the signal\n");
    }

    #[test]
    fn pump_carries_both_directions_and_propagates_input_eof() {
        let (near, far) = UnixStream::pair().expect("socketpair");
        let server = std::thread::spawn(move || {
            let mut far = far;
            let mut received = Vec::new();
            far.read_to_end(&mut received).expect("read to client EOF");
            far.write_all(b"reply\n").expect("write");
            received
            // Dropping `far` closes the server side; the pump must then end.
        });

        let mut output = Vec::new();
        pump(Cursor::new(b"request\n".to_vec()), &mut output, near).expect("pump");

        assert_eq!(server.join().unwrap(), b"request\n");
        assert_eq!(output, b"reply\n");
    }
}
