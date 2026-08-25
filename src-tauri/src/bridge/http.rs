//! The bridge's own surface: one port, one route, and no knowledge of what
//! an envelope means.
//!
//! Its own port on purpose. The artifacts surface serves HTML that agents
//! wrote, and a page loaded from there could call anything sharing its
//! origin — so the control plane does not share it. Two ports is a wall the
//! browser enforces without being asked, and it costs one bind.
//!
//! This is now the ONLY way an envelope reaches the deck. It was one of two
//! — the other was a file a reporter dropped in a watched directory — and
//! both ended at `wire::interpret` and `emit_inbound` on purpose, so that
//! when one went away nothing downstream had to notice.

use std::net::TcpStream;
use std::sync::Arc;

use tauri::AppHandle;

use crate::bridge::waiters::{Waiters, HOOK_WAIT};
use crate::bridge::wire::{interpret, Inbound};
use crate::http::request::{Limits, Method, Request};
use crate::http::{bind, respond_empty, respond_with_body, Listener, Status};

/// Where a reporter posts an envelope. One route, because the bridge speaks
/// one sentence: here is something that happened.
const ENVELOPE_PATH: &str = "/envelope";

/// Compose the address a reporter posts to.
///
/// Built HERE because the path is this module's constant: a caller that
/// assembled its own would be a second place that has to be told when the
/// route moves, and reporters carry the result byte-for-byte.
fn envelope_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{ENVELOPE_PATH}")
}

/// A bound bridge surface and the address it answers on.
pub(super) struct Surface {
    /// Held, never read: dropping it stops the accept loop, so the surface
    /// lives exactly as long as the `Bridge` that owns this value.
    _listener: Listener,
    pub(super) url: String,
}

/// Bind and serve. Called during boot, BEFORE any pane is spawned — a pane
/// started earlier would inherit an environment with no address in it, and
/// since the file lane was cut there is nothing else for it to use: its
/// reporters would report nothing for that pane's whole life.
pub(super) fn serve(app: AppHandle, waiters: Arc<Waiters>) -> Result<Surface, String> {
    let bound = bind("bridge")?;
    let port = bound.port;
    let listener = Listener::serve(
        bound,
        "bridge",
        Limits {
            // Reporters send small JSON — a statusline payload runs a few
            // KB — and anything past this is not ours.
            max_body: super::MAX_ENVELOPE_BYTES as usize,
        },
        move |mut stream, request| {
            let app = app.clone();
            handle(
                &mut stream,
                request,
                &waiters,
                &move |inbound| super::emit_inbound(&app, inbound),
            );
        },
    )?;
    Ok(Surface {
        _listener: listener,
        url: envelope_url(port),
    })
}

/// Route one request. The EFFECT is injected rather than reached for: a
/// Tauri handle cannot be built in a unit test, and a route nobody can
/// exercise is a route nobody has checked.
fn handle(
    stream: &mut TcpStream,
    request: Request,
    waiters: &Waiters,
    emit: &dyn Fn(Inbound),
) {
    // Matched as a pair: an unknown path and a wrong method answer the same
    // 404, so probing tells a caller nothing it did not already know.
    if !matches!((&request.method, request.path.as_str()), (Method::Post, ENVELOPE_PATH)) {
        let _ = respond_empty(stream, Status::NotFound);
        return;
    }
    // Invalid UTF-8 is malformed, not empty: an envelope is JSON, and a body
    // that cannot be text was never one.
    let Ok(content) = std::str::from_utf8(&request.body) else {
        log::warn!("bridge: dropped envelope: not utf-8");
        let _ = respond_empty(stream, Status::BadRequest);
        return;
    };
    match interpret(content) {
        Ok(inbound) => {
            // A report that asks holds the connection until the deck answers
            // it. The correlation is read where envelope shape is known, not
            // here — a route reaching into the payload would be a second
            // reader of the same field.
            //
            // The PANE travels with it: an answer is addressed, and the pane
            // that asked is half that address.
            let asked = match &inbound {
                Inbound::Opaque { report, .. } => report
                    .correlation()
                    .map(|correlation| (report.pane_id.clone(), correlation.to_string())),
                Inbound::SessionBound(_) => None,
            };
            match asked {
                None => {
                    emit(inbound);
                    // Accepted, nothing to say back. Most reports are this.
                    let _ = respond_empty(stream, Status::NoContent);
                }
                Some((pane, correlation)) => {
                    // The slot is taken BEFORE the deck is told, so an ask
                    // reusing a correlation that is still in flight is
                    // refused without the deck ever answering it — its
                    // answer would be handed to the first asker, which is
                    // still parked on that pair.
                    let Some(parked) = waiters.park(&pane, &correlation) else {
                        log::warn!("bridge: {correlation} is already being asked on");
                        let _ = respond_empty(stream, Status::Conflict);
                        return;
                    };
                    emit(inbound);
                    match parked.wait(HOOK_WAIT) {
                    // Answered, and there was nothing waiting. That is the
                    // common end to a turn, and 204 is what it means — the
                    // deck already treats an empty answer as a thing that
                    // loses nothing and needs no collecting.
                    Some(answer) if answer.is_empty() => {
                        let _ = respond_empty(stream, Status::NoContent);
                    }
                    // The answer, verbatim: the deck rendered it through the
                    // asking agent's own plugin, so this carries bytes and
                    // never reads them.
                    Some(answer) => {
                        let _ = respond_with_body(
                            stream,
                            Status::Ok,
                            "text/plain; charset=utf-8",
                            answer.as_bytes(),
                            &[],
                        );
                    }
                    // Nobody answered in time. NOT an empty answer, which
                    // means "nothing was waiting for you" — this means the
                    // deck may already have handed messages over, and the
                    // hook must not read silence as emptiness.
                    None => {
                        log::warn!("bridge: nobody answered {correlation} in time");
                        let _ = respond_empty(stream, Status::GatewayTimeout);
                    }
                    }
                }
            }
        }
        // Dropped-and-logged: a reporter that wrote nonsense gets told, and
        // nothing retries into a loop.
        Err(reason) => {
            log::warn!("bridge: dropped envelope: {reason}");
            let _ = respond_empty(stream, Status::BadRequest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// Post one request at `handle` over a real socket and read the status
    /// line back, recording whatever it chose to emit.
    fn post(method: &str, path: &str, body: &[u8]) -> (String, usize) {
        post_with(method, path, body, &Waiters::default())
    }

    /// The same round trip, against a chosen set of waiters — so a test can
    /// have somebody already parked, or nobody at all.
    fn post_with(
        method: &str,
        path: &str,
        body: &[u8],
        waiters: &Waiters,
    ) -> (String, usize) {
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
        handle(&mut accepted, request, waiters, &|_| {
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
            "v": 2,
            "type": "agent.status",
            "paneId": pane,
            "token": "tok",
            "payload": { "agent": "claude", "event": { "type": "Stop" } }
        })
        .to_string()
    }

    #[test]
    fn a_posted_envelope_is_acted_on_not_merely_accepted() {
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

    fn asking_envelope(pane: &str, correlation: &str) -> String {
        serde_json::json!({
            "v": 2,
            "type": "agent.status",
            "paneId": pane,
            "token": "tok",
            "payload": {
                "agent": "claude",
                "reply": correlation,
                "event": { "type": "Stop" }
            }
        })
        .to_string()
    }

    #[test]
    fn a_report_that_asks_gets_the_decks_answer_on_the_same_connection() {
        let waiters = Arc::new(Waiters::default());
        let answering = Arc::clone(&waiters);
        std::thread::spawn(move || {
            for _ in 0..200 {
                if answering.resolve("pane-1", "corr-1", "[mail-7] read me".into()) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let envelope = asking_envelope("pane-1", "corr-1");
        let head = format!(
            "POST {ENVELOPE_PATH} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n",
            envelope.len()
        );
        let peer = std::thread::spawn(move || {
            let mut peer = TcpStream::connect(("127.0.0.1", port)).unwrap();
            peer.write_all(head.as_bytes()).unwrap();
            peer.write_all(envelope.as_bytes()).unwrap();
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
        .unwrap();
        handle(&mut accepted, request, &waiters, &|_| {});
        drop(accepted);
        let answer = peer.join().unwrap();
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        assert!(
            answer.ends_with("[mail-7] read me"),
            "the answer travels verbatim: {answer}"
        );
    }

    #[test]
    fn an_answer_that_is_empty_says_so_with_its_own_code() {
        // "Nothing was waiting" is not "here is your mail, it is blank".
        let waiters = Arc::new(Waiters::default());
        let answering = Arc::clone(&waiters);
        std::thread::spawn(move || {
            for _ in 0..200 {
                if answering.resolve("pane-1", "corr-empty", String::new()) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });
        let (status, _) = post_with(
            "POST",
            ENVELOPE_PATH,
            asking_envelope("pane-1", "corr-empty").as_bytes(),
            &waiters,
        );
        assert!(status.starts_with("HTTP/1.1 204"), "{status}");
    }

    #[test]
    fn a_second_ask_on_a_live_correlation_never_reaches_the_deck() {
        // The deck would answer it "nothing waiting" — the first ask having
        // just emptied the queue — and that answer would go to the FIRST
        // asker, which is still parked on this pair.
        let waiters = Waiters::default();
        let held = waiters.park("pane-1", "corr-busy").expect("the slot is free");
        let (status, emitted) = post_with(
            "POST",
            ENVELOPE_PATH,
            asking_envelope("pane-1", "corr-busy").as_bytes(),
            &waiters,
        );
        assert!(status.starts_with("HTTP/1.1 409"), "{status}");
        assert_eq!(emitted, 0, "the deck must not hear an ask it may not answer");
        drop(held);
    }

    #[test]
    fn silence_is_not_reported_as_an_empty_answer() {
        // Empty means "nothing was waiting for you" and loses nothing. A
        // deck that never answered may already have handed messages over,
        // so the hook must be able to tell the two apart.
        let waiters = Waiters::default();
        let (status, _) = post_with(
            "POST",
            ENVELOPE_PATH,
            asking_envelope("pane-1", "corr-nobody").as_bytes(),
            &waiters,
        );
        assert!(status.starts_with("HTTP/1.1 504"), "{status}");
    }
}
