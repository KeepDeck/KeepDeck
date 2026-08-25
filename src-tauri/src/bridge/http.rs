//! The bridge's own surface: one port, one route, and no knowledge of what
//! an envelope means.
//!
//! Its own port on purpose. The artifacts surface serves HTML that agents
//! wrote, and a page loaded from there could call anything sharing its
//! origin — so the control plane does not share it. Two ports is a wall the
//! browser enforces without being asked, and it costs one bind.
//!
//! What arrives here goes to the SAME place a file in the inbox goes:
//! `wire::interpret` to read it, `emit_inbound` to act on it. The transport
//! is the only difference between the two doors, and it stops at this file.

use std::net::TcpStream;

use tauri::AppHandle;

use crate::bridge::wire::{interpret, Inbound};
use crate::http::request::{Limits, Request};
use crate::http::{bind, respond_empty, Listener};

/// Where a reporter posts an envelope. One route, because the bridge speaks
/// one sentence: here is something that happened.
const ENVELOPE_PATH: &str = "/envelope";

/// A bound bridge surface and the port it answers on.
pub(super) struct Surface {
    /// Held, never read: dropping it stops the accept loop, so the surface
    /// lives exactly as long as the `Bridge` that owns this value.
    _listener: Listener,
    pub(super) port: u16,
}

/// Bind and serve. Called during boot, BEFORE any pane is spawned — a pane
/// started earlier would inherit an environment with no address in it and
/// fall back to writing files, silently and for its whole life.
pub(super) fn serve(app: AppHandle) -> Result<Surface, String> {
    let bound = bind("bridge")?;
    let port = bound.port;
    let listener = Listener::serve(
        bound,
        "bridge",
        Limits {
            // The same cap the inbox enforces on a file. One number for one
            // rule: an envelope is an envelope whichever door it came in.
            max_body: super::MAX_ENVELOPE_BYTES as usize,
        },
        move |mut stream, request| {
            let app = app.clone();
            handle(&mut stream, request, &move |inbound| super::emit_inbound(&app, inbound));
        },
    )?;
    Ok(Surface {
        _listener: listener,
        port,
    })
}

/// Route one request. The EFFECT is injected rather than reached for: a
/// Tauri handle cannot be built in a unit test, and a route nobody can
/// exercise is a route nobody has checked.
fn handle(stream: &mut TcpStream, request: Request, emit: &dyn Fn(Inbound)) {
    if request.method != "POST" || request.path != ENVELOPE_PATH {
        // No oracle here either: an unknown path and a wrong method answer
        // the same 404, so probing tells a caller nothing it did not know.
        let _ = respond_empty(stream, 404);
        return;
    }
    // Invalid UTF-8 is malformed, not empty — the file lane reads to a
    // String and refuses the same way, and two lanes disagreeing about what
    // counts as an envelope is the drift this route exists to avoid.
    let Ok(content) = std::str::from_utf8(&request.body) else {
        log::warn!("bridge: dropped envelope: not utf-8");
        let _ = respond_empty(stream, 400);
        return;
    };
    match interpret(content) {
        Ok(inbound) => {
            emit(inbound);
            // 204: accepted, nothing to say back. The reply half — the
            // question a hook asks at a turn boundary — is not this route
            // and does not exist yet; a hook still collects its answer the
            // old way until the adapter lands.
            let _ = respond_empty(stream, 204);
        }
        // Dropped-and-logged, exactly as a garbage file is: a reporter that
        // wrote nonsense gets told, and nothing retries into a loop.
        Err(reason) => {
            log::warn!("bridge: dropped envelope: {reason}");
            let _ = respond_empty(stream, 400);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::Mutex;

    /// Post one request at `handle` over a real socket and read the status
    /// line back, recording whatever it chose to emit.
    fn post(method: &str, path: &str, body: &[u8]) -> (String, usize) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        let sent = body.to_vec();
        let peer = std::thread::spawn(move || {
            let mut peer = TcpStream::connect(("127.0.0.1", port)).unwrap();
            peer.write_all(head.as_bytes()).unwrap();
            peer.write_all(&sent).unwrap();
            peer.flush().unwrap();
            let mut answer = String::new();
            let _ = peer.read_to_string(&mut answer);
            answer
        });
        let (mut accepted, _) = listener.accept().unwrap();
        let request = crate::http::read_request(
            &mut accepted,
            Limits {
                max_body: super::super::MAX_ENVELOPE_BYTES as usize,
            },
        )
        .expect("the head must parse");
        let seen = Mutex::new(0usize);
        handle(&mut accepted, request, &|_| {
            *seen.lock().unwrap() += 1;
        });
        drop(accepted);
        let answer = peer.join().unwrap();
        let status = answer.lines().next().unwrap_or("").to_string();
        let count = *seen.lock().unwrap();
        (status, count)
    }

    fn status_envelope(pane: &str) -> String {
        serde_json::json!({
            "v": 1,
            "type": "agent.status",
            "paneId": pane,
            "token": "tok",
            "payload": { "agent": "claude", "event": { "type": "Stop" } }
        })
        .to_string()
    }

    #[test]
    fn a_posted_envelope_reaches_the_same_place_a_file_would() {
        let (status, emitted) = post("POST", ENVELOPE_PATH, status_envelope("pane-1").as_bytes());
        assert!(status.starts_with("HTTP/1.1 204"), "{status}");
        assert_eq!(emitted, 1, "the envelope must be acted on, not just accepted");
    }

    #[test]
    fn a_wrong_method_and_an_unknown_path_answer_the_same_404() {
        let (by_method, _) = post("GET", ENVELOPE_PATH, b"");
        let (by_path, _) = post("POST", "/nope", b"");
        assert!(by_method.starts_with("HTTP/1.1 404"), "{by_method}");
        assert_eq!(by_method, by_path, "probing must not distinguish the two");
    }

    #[test]
    fn garbage_is_dropped_with_a_status_rather_than_retried() {
        let (status, emitted) = post("POST", ENVELOPE_PATH, b"{not an envelope");
        assert!(status.starts_with("HTTP/1.1 400"), "{status}");
        assert_eq!(emitted, 0);
    }

    #[test]
    fn a_body_that_is_not_utf8_is_malformed_not_empty() {
        let (status, emitted) = post("POST", ENVELOPE_PATH, &[0xff, 0xfe, 0xfd]);
        assert!(status.starts_with("HTTP/1.1 400"), "{status}");
        assert_eq!(emitted, 0);
    }
}
