//! The bridge's own surface: its door, a unix socket of this run's own; one
//! route, and no knowledge of what an envelope means.
//!
//! The door is where a sender is judged by what the kernel says of it: the
//! process on the far end of the socket, which the sessions machine places
//! in a pane's terminal or nowhere, and the pane's bridge secret — both
//! checked before anything is parked or emitted. It answered on a TCP port
//! once, whose peer is nobody the kernel can name: a process anywhere could
//! speak for any pane by naming a process inside it.
//!
//! This is the ONLY way an envelope reaches the deck. A file a reporter
//! dropped in a watched directory was another once, and every lane ended at
//! `wire::interpret` and `emit_inbound` on purpose, so that when one went
//! away nothing downstream had to notice.

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use keepdeck_pty::sessions::{Door, Secret};
use tauri::{AppHandle, Manager, Runtime};

use crate::bridge::origin::{self, Refusal};
use crate::bridge::waiters::{Waiters, HOOK_WAIT};
use crate::bridge::wire::{interpret, printable, Inbound};
use crate::http::request::{Limits, Method, Request};
use crate::http::{bound, read_request, respond_empty, respond_with_body, Status};
use crate::session_machine::SessionMachine;
use crate::unix_door::{Serve, UnixDoor};

/// Where a reporter posts an envelope. One route, because the bridge speaks
/// one sentence: here is something that happened.
const ENVELOPE_PATH: &str = "/envelope";

/// What the door reads of a request. Reporters send small JSON — a
/// statusline payload runs a few KB — and anything past this is not ours.
const LIMITS: Limits = Limits { max_body: super::MAX_ENVELOPE_BYTES as usize };

/// A sender's judgment, before anything it sent is parked or emitted.
type Judge<'a> = &'a dyn Fn(&Inbound) -> Result<(), Refusal>;

/// Open the bridge's door at `socket`. Called once the sessions machine is
/// managed, BEFORE any pane is spawned: the door asks it of every sender
/// from its first connection on, and a pane started earlier would inherit
/// an environment with no door in it — its reporters would report nothing
/// for that pane's whole life.
pub(super) fn open_door<R: Runtime>(app: AppHandle<R>, waiters: Arc<Waiters>, socket: &Path) -> Result<UnixDoor, String> {
    let sessions = app.state::<SessionMachine>().inner().clone();
    let judge = move |peer, inbound: &Inbound| {
        let reporter = inbound.reporter();
        let secret = Secret::new(inbound.token());
        let caller = sessions.caller(peer, Some(&secret), origin::named(reporter.as_deref()), Door::Bridge);
        origin::admitted(tauri::async_runtime::block_on(caller), inbound.pane())
    };
    UnixDoor::open(socket, "bridge", door(waiters, judge, move |inbound| super::emit_inbound(&app, inbound)))
}

/// What the door does with each connection: bound it, read its one request,
/// and route it with its sender judged by `judge(peer, envelope)` — `peer`
/// being the process the kernel names on the socket's far end. The effects
/// are injected for the same reason as [`handle`]'s.
fn door(
    waiters: Arc<Waiters>,
    judge: impl Fn(Option<u32>, &Inbound) -> Result<(), Refusal> + Send + Sync + 'static,
    emit: impl Fn(Inbound) + Send + Sync + 'static,
) -> Serve {
    Arc::new(move |mut stream: UnixStream, peer| {
        serve_connection(&mut stream, waiters.as_ref(), &|inbound| judge(peer, inbound), &emit);
    })
}

/// One connection at the door. The ask's patience counts from here: the
/// judging, which may wait for a terminal still being registered, is spent
/// from it, and the sender's own patience outlasts the whole.
fn serve_connection(stream: &mut UnixStream, waiters: &Waiters, judge: Judge, emit: &dyn Fn(Inbound)) {
    let arrived = Instant::now();
    match bound(&*stream).and_then(|()| read_request(stream, LIMITS)) {
        Ok(request) => handle(stream, request, waiters, arrived, judge, emit),
        Err(status) => {
            let _ = respond_empty(stream, status);
        }
    }
}

/// Route one request that arrived at `arrived`. The EFFECT is injected
/// rather than reached for: a Tauri handle cannot be built in a unit test,
/// and a route nobody can exercise is a route nobody has checked.
///
/// `judge` says whether the sender may speak for the pane its envelope
/// names, by the kernel's word on it.
fn handle(stream: &mut impl Write, request: Request, waiters: &Waiters, arrived: Instant, judge: Judge, emit: &dyn Fn(Inbound)) {
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
            // Before anything is parked or emitted: a report from outside the
            // pane is nobody's, and an ask from there must not be answered
            // with the pane's mail. 403 tells an in-process reporter it is
            // not this pane's — the one sender that acts on the answer.
            let reporter = inbound.reporter();
            if let Err(refusal) = judge(&inbound) {
                log::warn!(
                    "bridge: refused envelope for pane={} from {}: {}",
                    printable(inbound.pane()),
                    printable(reporter.as_deref().unwrap_or_default()),
                    refusal.reason(),
                );
                let _ = respond_empty(stream, Status::Forbidden);
                return;
            }
            // A report that asks holds the connection until the deck answers
            // it. The correlation is read where envelope shape is known, not
            // here — a route reaching into the payload would be a second
            // reader of the same field.
            //
            // The PANE travels with it: an answer is addressed, and the pane
            // that asked is half that address.
            //
            // Neither is trusted text. Both come out of an envelope a pane's
            // own process wrote, so every line below that logs one strips it
            // first — a newline in a correlation forges a second entry in
            // keepdeck.log, and the log is the only window onto this lane.
            let asked = match &inbound {
                Inbound::Opaque { report, .. } => report
                    .correlation()
                    .map(|correlation| (report.pane_id.clone(), correlation.to_string())),
                Inbound::SessionBound { .. } => None,
            };
            match asked {
                None => {
                    emit(inbound);
                    // Accepted, nothing to say back. Most reports are this.
                    let _ = respond_empty(stream, Status::NoContent);
                }
                Some((pane, correlation)) => {
                    // An ask whose patience was spent reaching here — read
                    // slowly, judged after a wait for its terminal — is
                    // answered as one nobody answered in time, before anyone
                    // sees it: told to the deck, it could still be handed the
                    // pane's mail, and its sender has given up on hearing it.
                    if arrived.elapsed() >= HOOK_WAIT {
                        log::warn!("bridge: {} arrived too late to be asked", printable(&correlation));
                        let _ = respond_empty(stream, Status::GatewayTimeout);
                        return;
                    }
                    // The slot is taken BEFORE the deck is told, so an ask
                    // reusing a correlation that is still in flight is
                    // refused without the deck ever answering it — its
                    // answer would be handed to the first asker, which is
                    // still parked on that pair.
                    let Some(parked) = waiters.park(&pane, &correlation) else {
                        log::warn!(
                            "bridge: {} is already being asked on",
                            printable(&correlation)
                        );
                        let _ = respond_empty(stream, Status::Conflict);
                        return;
                    };
                    emit(inbound);
                    match parked.wait(HOOK_WAIT.saturating_sub(arrived.elapsed())) {
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
                        log::warn!(
                            "bridge: nobody answered {} in time",
                            printable(&correlation)
                        );
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
    use crate::bridge::wire::BRIDGE_PROTOCOL_VERSION;
    use crate::http::request::{HEAD_TIMEOUT, WRITE_TIMEOUT};
    use crate::unix_door::test_support::temp_sock;
    use keepdeck_pty::sessions::CallerRefusal;
    use std::io::Read as _;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// Post one request at a connection of the door and read the status line
    /// back, recording whatever it chose to emit.
    fn post(method: &str, path: &str, body: &[u8]) -> (String, usize) {
        post_with(method, path, body, &Waiters::default())
    }

    /// Every sender admitted — who may speak is not what these tests are
    /// about, except the ones that say otherwise.
    fn post_with(method: &str, path: &str, body: &[u8], waiters: &Waiters) -> (String, usize) {
        post_judged(method, path, body, waiters, &|_| Ok(()))
    }

    /// The same round trip, against a chosen set of waiters — so a test can
    /// have somebody already parked, or nobody at all — and a chosen word on
    /// the sender.
    fn post_judged(method: &str, path: &str, body: &[u8], waiters: &Waiters, judge: Judge) -> (String, usize) {
        let (answer, count) = exchange(method, path, body, waiters, judge);
        (answer.lines().next().unwrap_or("").to_string(), count)
    }

    /// One whole exchange over a socket pair, as the door serves a
    /// connection: the answer, and how many envelopes were emitted. The
    /// request is written whole first — a pair buffers far more than any
    /// request here.
    fn exchange(method: &str, path: &str, body: &[u8], waiters: &Waiters, judge: Judge) -> (String, usize) {
        let (mut client, mut served) = UnixStream::pair().expect("socketpair");
        write!(client, "{method} {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n", body.len()).unwrap();
        client.write_all(body).unwrap();
        let seen = Mutex::new(0usize);
        serve_connection(&mut served, waiters, judge, &|_| *seen.lock().unwrap() += 1);
        drop(served);
        let mut answer = String::new();
        let _ = client.read_to_string(&mut answer);
        let count = *seen.lock().unwrap();
        (answer, count)
    }

    fn status_envelope(pane: &str) -> String {
        serde_json::json!({
            "v": BRIDGE_PROTOCOL_VERSION,
            "type": "agent.status",
            "paneId": pane,
            "token": "tok",
            "payload": { "agent": "claude", "event": { "type": "Stop" } }
        })
        .to_string()
    }

    fn reported_envelope(pane: &str, reporter: &str) -> String {
        serde_json::json!({
            "v": BRIDGE_PROTOCOL_VERSION,
            "type": "companion.hello",
            "paneId": pane,
            "token": "tok",
            "payload": { "agent": "claude", "reporter": reporter }
        })
        .to_string()
    }

    #[test]
    fn an_ask_from_outside_is_refused_before_it_parks() {
        // Parked, it would be handed the pane's mail.
        let waiters = Waiters::default();
        let body = serde_json::json!({
            "v": BRIDGE_PROTOCOL_VERSION, "type": "agent.status", "paneId": "pane-5", "token": "tok",
            "payload": { "agent": "claude", "reporter": "4021", "reply": "corr-1" }
        })
        .to_string();
        // Judged before the slot is taken, not taken and handed back: while
        // held, an answer for the pane could already be on its way to it.
        let outside = |_: &Inbound| {
            assert!(waiters.park("pane-5", "corr-1").is_some(), "the ask was parked before it was judged");
            Err(Refusal::Caller(CallerRefusal::OutsideTerminal))
        };
        let (status, emitted) = post_judged("POST", ENVELOPE_PATH, body.as_bytes(), &waiters, &outside);
        assert!(status.starts_with("HTTP/1.1 403"), "{status}");
        assert_eq!(emitted, 0);
        assert!(!waiters.resolve("pane-5", "corr-1", "mail".into()), "nobody may be parked");
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
            "v": BRIDGE_PROTOCOL_VERSION,
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
        let envelope = asking_envelope("pane-1", "corr-1");
        let (answer, _) = exchange("POST", ENVELOPE_PATH, envelope.as_bytes(), &waiters, &|_| Ok(()));
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

    /// Every line this route hands the logger, in this test binary.
    ///
    /// A route's log output IS the consumed end of the stripping: asserting
    /// that `printable` works proves nothing about whether anyone called it.
    /// Other tests log into this too, so a case filters for its own marker.
    static CAPTURED: Mutex<Vec<String>> = Mutex::new(Vec::new());

    struct Capture;

    impl log::Log for Capture {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            CAPTURED
                .lock()
                .expect("capture poisoned")
                .push(record.args().to_string());
        }
        fn flush(&self) {}
    }

    fn capture_logs() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            // Best-effort: a binary that already has a logger keeps it, and
            // the assertion below then finds no marker and says so.
            let _ = log::set_boxed_logger(Box::new(Capture));
            log::set_max_level(log::LevelFilter::Warn);
        });
    }

    #[test]
    fn a_correlation_cannot_forge_a_second_line_in_the_log() {
        // The correlation comes out of an envelope, so it is whatever the
        // pane's process wrote. A newline in it appends an entry of the
        // agent's own composing to keepdeck.log — which is the only window
        // onto this lane, and the place an operator looks to find out what a
        // pane did.
        capture_logs();
        let hostile = "corr-FORGERYMARK\n[bridge] pane-9 bound session=stolen";
        let (status, _) = post_with(
            "POST",
            ENVELOPE_PATH,
            asking_envelope("pane-1", hostile).as_bytes(),
            &Waiters::default(),
        );
        // Nobody answers, so the timeout line is the one that gets written.
        assert!(status.starts_with("HTTP/1.1 504"), "{status}");

        let lines = CAPTURED.lock().expect("capture poisoned");
        let ours: Vec<&String> = lines
            .iter()
            .filter(|line| line.contains("FORGERYMARK"))
            .collect();
        // The guard has to SEE the line, or it passes by finding nothing —
        // exactly what would happen if the route stopped logging at all.
        assert!(!ours.is_empty(), "the timeout line was never logged");
        for line in ours {
            assert!(
                !line.chars().any(char::is_control),
                "a control character reached the log: {line:?}"
            );
        }
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

    /// One request through a real door at a fresh socket, its sender judged
    /// by `judge`: the status line back, and how many envelopes the deck
    /// heard.
    fn knock(body: &str, judge: impl Fn(Option<u32>, &Inbound) -> Result<(), Refusal> + Send + Sync + 'static) -> (String, usize) {
        let path = temp_sock();
        let heard = Arc::new(Mutex::new(0usize));
        let counted = Arc::clone(&heard);
        let emit = move |_| *counted.lock().unwrap() += 1;
        let opened = UnixDoor::open(&path, "bridge test", door(Arc::new(Waiters::default()), judge, emit)).expect("open");
        let mut client = UnixStream::connect(&path).expect("connect");
        write!(client, "POST {ENVELOPE_PATH} HTTP/1.1\r\nHost: keepdeck\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        let mut answer = String::new();
        let _ = client.read_to_string(&mut answer);
        drop(opened);
        let status = answer.lines().next().unwrap_or("").to_string();
        let count = *heard.lock().unwrap();
        (status, count)
    }

    #[test]
    fn the_door_judges_each_sender_by_the_process_the_kernel_names_and_the_secret_it_names() {
        let judged = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&judged);
        let (status, heard) = knock(&status_envelope("pane-1"), move |peer, inbound| {
            seen.lock().unwrap().push((peer, inbound.token().to_string()));
            Ok(())
        });
        assert!(status.starts_with("HTTP/1.1 204"), "{status}");
        assert_eq!(heard, 1);
        let this = cfg!(any(target_os = "macos", target_os = "linux")).then(std::process::id);
        assert_eq!(*judged.lock().unwrap(), vec![(this, "tok".to_string())]);
    }

    #[test]
    fn a_sender_the_door_refuses_is_answered_403_and_never_heard() {
        for refusal in [
            Refusal::Caller(CallerRefusal::OutsideTerminal),
            Refusal::Caller(CallerRefusal::WrongSecret),
            Refusal::Caller(CallerRefusal::NamedOutside),
            Refusal::OtherPane,
        ] {
            let (status, heard) = knock(&reported_envelope("pane-5", "4021"), move |_, _| Err(refusal));
            assert!(status.starts_with("HTTP/1.1 403"), "{refusal:?}: {status}");
            assert_eq!(heard, 0, "{refusal:?}");
        }
    }

    #[test]
    fn an_asks_patience_counts_from_its_arrival() {
        // Judging a sender may wait for a terminal still being registered.
        // That wait is spent from the ask's patience, not added to it, or
        // the sender — whose own patience barely outlasts the deck's — would
        // give up first and read a socket error instead of the deck's 504.
        let arrived = Instant::now().checked_sub(HOOK_WAIT).expect("the clock runs further back");
        let request = Request {
            method: Method::Post,
            path: ENVELOPE_PATH.into(),
            query: None,
            body: asking_envelope("pane-1", "corr-late").into_bytes(),
        };
        let waiters = Waiters::default();
        let emitted = Mutex::new(0usize);
        let mut answer = Vec::new();
        let started = Instant::now();
        handle(&mut answer, request, &waiters, arrived, &|_| Ok(()), &|_| *emitted.lock().unwrap() += 1);
        assert!(String::from_utf8_lossy(&answer).starts_with("HTTP/1.1 504"));
        assert!(started.elapsed() < Duration::from_millis(500), "waited {:?} past a spent patience", started.elapsed());
        // Its sender has given up: the deck is never told, so nothing of the
        // pane's mail can be handed to an ask nobody will read.
        assert_eq!(*emitted.lock().unwrap(), 0, "a spent ask reached the deck");
        assert!(waiters.park("pane-1", "corr-late").is_some(), "a spent ask held its slot");
    }

    #[test]
    fn an_ask_read_too_slowly_to_be_answered_is_never_told_to_the_deck() {
        // Its patience counts from the connection, not from a parsed request:
        // a body that takes the whole of it to arrive leaves nothing to wait
        // with, and the deck is never asked.
        let (mut client, mut served) = UnixStream::pair().expect("socketpair");
        let envelope = asking_envelope("pane-1", "corr-slow");
        write!(client, "POST {ENVELOPE_PATH} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n", envelope.len()).unwrap();
        let mut late = client.try_clone().expect("clone");
        // Timed from the door's own bound, which it sets once it took the
        // connection: the patience is the whole wait from there.
        let probe = served.try_clone().expect("clone");
        let sender = std::thread::spawn(move || {
            while probe.read_timeout().expect("read bound").is_none() {
                std::thread::sleep(Duration::from_millis(1));
            }
            std::thread::sleep(HOOK_WAIT);
            late.write_all(envelope.as_bytes()).unwrap();
        });
        let waiters = Waiters::default();
        let emitted = Mutex::new(0usize);
        serve_connection(&mut served, &waiters, &|_| Ok(()), &|_| *emitted.lock().unwrap() += 1);
        sender.join().unwrap();
        drop(served);
        let mut answer = String::new();
        let _ = client.read_to_string(&mut answer);
        assert!(answer.starts_with("HTTP/1.1 504"), "{answer}");
        assert_eq!(*emitted.lock().unwrap(), 0, "the deck was told of an ask past its patience");
        assert!(waiters.park("pane-1", "corr-slow").is_some(), "a spent ask held its slot");
    }

    #[test]
    fn a_connection_at_the_door_is_bounded_while_its_head_is_still_being_read() {
        // The bound has to be on the socket BEFORE the read it bounds: set
        // after the head is parsed, a peer that stalls mid-head holds the
        // thread for good, and the bound reads correctly afterwards anyway.
        let (mut client, mut served) = UnixStream::pair().expect("socketpair");
        let probe = served.try_clone().expect("clone");
        client.write_all(b"GET /nope HTTP/1.1\r\n").expect("write");
        let serving = std::thread::spawn(move || serve_connection(&mut served, &Waiters::default(), &|_| Ok(()), &|_| {}));
        let deadline = Instant::now() + Duration::from_secs(2);
        let bounds = || (probe.read_timeout().expect("read bound"), probe.write_timeout().expect("write bound"));
        while bounds() != (Some(HEAD_TIMEOUT), Some(WRITE_TIMEOUT)) {
            assert!(Instant::now() < deadline, "the head is being read with no bound on it: {:?}", bounds());
            std::thread::sleep(Duration::from_millis(5));
        }
        client.write_all(b"Host: x\r\n\r\n").expect("write");
        serving.join().unwrap();
    }
}
