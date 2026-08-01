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

/// A parsed `--mcp-shim` invocation. `socket` overrides the default
/// `<keepdeck_home>/mcp.sock` — test isolation and deliberate cross-flavor
/// connects.
pub struct ShimMode {
    pub socket: Option<PathBuf>,
}

/// Detect the shim flag anywhere in argv; the value, when present, is the
/// argument right after it. None means "boot the app normally".
pub fn shim_mode(args: impl IntoIterator<Item = String>) -> Option<ShimMode> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--mcp-shim" {
            return Some(ShimMode {
                socket: args.next().map(PathBuf::from),
            });
        }
    }
    None
}

/// Run the pump to completion. Returns the process exit code: 0 once the
/// server closes the connection (toggle Off, app quit), non-zero when there
/// is nothing to connect to — with a hint, because "server not enabled" is
/// the overwhelmingly likely cause.
pub fn run(mode: ShimMode) -> i32 {
    let Some(path) = mode
        .socket
        .or_else(|| crate::paths::keepdeck_home().map(|home| home.join("mcp.sock")))
    else {
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
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if uplink.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
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

    fn temp_sock(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kd-shim-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join("mcp.sock")
    }

    #[test]
    fn shim_and_server_speak_end_to_end() {
        // The real server (mcp_server) and the real pump, joined by the real
        // socket: client EOF propagates through the shim to the server, whose
        // connection close ends the pump — the whole life of a session.
        let path = temp_sock("e2e");
        let handler: crate::mcp_server::LineHandler =
            std::sync::Arc::new(|line: &str| Some(line.to_uppercase()));
        let server = crate::mcp_server::McpServer::default();
        server.enable(&path, handler).expect("server");

        let socket = UnixStream::connect(&path).expect("connect");
        let output = SharedBuf::default();
        pump(Cursor::new(b"hello\n".to_vec()), &mut output.clone(), socket).expect("pump");

        assert_eq!(output.0.lock().unwrap().as_slice(), b"HELLO\n");
        server.disable();
    }

    #[test]
    fn disabling_the_server_releases_a_connected_shim() {
        let path = temp_sock("disable");
        let handler: crate::mcp_server::LineHandler =
            std::sync::Arc::new(|line: &str| Some(line.to_uppercase()));
        let server = crate::mcp_server::McpServer::default();
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
