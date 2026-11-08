//! Usage tailer — per-pane session-file followers (Claude transcripts,
//! Codex rollouts, Kimi wire logs), and the ROUTER of what they yield:
//! usage events to the usage channel, recovered interrupt markers to the
//! status channel. The concerns live in submodules — `dialects` (which
//! lines matter per CLI), `reader` (incremental byte draining), `totals`
//! (running token cumulatives), `route` (wire shapes and the two-channel
//! decision), `rollouts` (cold codex-store discovery) — this module owns
//! the followed STATE and the poll/arm lifecycle around them.
//!
//! Three deliberate choices:
//! - Session files are POLLED (a 2s stat + drain-on-growth thread), not
//!   OS-watched: every CLI keeps its session file OPEN and appends without
//!   closing, and FSEvents is blind to exactly that pattern until
//!   close/rename (reproduced by the open-handle test below — the chip
//!   froze on stale catch-up data in the field), while notify's PollWatcher
//!   compares mtime at SECONDS granularity and misses same-second appends.
//!   Statting the root file (plus Claude's subagent transcripts) per tick is
//!   cheaper than either, and a
//!   not-yet-created file (or parent) simply arrives on a later tick.
//! - Registration immediately drains the EXISTING file and emits only the
//!   LAST token_count and turn_context found — instant restore of limits
//!   and model after an app restart, without replaying a session's history.
//! - Reads are incremental and bounded (offset + carried partial line,
//!   processed in fixed-size chunks — no whole-file buffer or front-shifting
//!   vector); both are byte-wise, so
//!   a torn multi-byte character or half-written line never breaks parsing;
//!   it completes on the next poll).

#[cfg(test)]
mod context_tests;
mod dialects;
mod reader;
mod route;
#[cfg(test)]
mod test_support;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::bridge::{Report, AGENT_STATUS_EVENT, USAGE_REPORT_EVENT};
use crate::fswatch;

use dialects::{
    calls_since, drop_superseded, last_of_each, last_status_of_each, sibling_paths, TailLane,
    TailWatch, TailedEvent,
};
use reader::{drain_file, TailCursor};
use route::{batch_status, route, wrap, Routed};

/// One followed session: where every source file is up to and how to
/// attribute what it yields. The token is the pane's spawn-plan secret,
/// passed by the webview at watch time so tailer reports ride the reporter
/// envelope's verification path.
struct TailState {
    path: PathBuf,
    pane_id: String,
    token: String,
    /// The agent whose pane this is, as the deck knows it — passed at
    /// arming rather than derived here. Reports ride under it, and the side
    /// that hands it over is the side that knows which plugin will read
    /// them back.
    agent: String,
    root: TailCursor,
    /// What this pane's agent asked to have carried out of its store. An
    /// empty list follows a file and carries nothing: there are no readings
    /// of our own left to fall back on.
    watches: Vec<TailWatch>,
    /// A directory of files contributing to the SAME session, when this
    /// agent's dialect named one. Listed every poll: the files appear as
    /// the work that writes them starts.
    siblings: Option<PathBuf>,
    /// Other stores of the same session a record named (codex's subagent
    /// threads), added by [`usage_link_session_file`] as they are found.
    linked: Vec<PathBuf>,
    /// The cursor of every file besides the root: siblings and linked.
    subagents: HashMap<PathBuf, TailCursor>,
    /// From when (unix ms) a file read again carries its calls — where the
    /// ledger stopped booking this session. None carries every call.
    since: Option<f64>,
}

impl TailState {
    /// Carry `watches` from here on, without reading again what was read:
    /// every cursor stays where it stands.
    ///
    /// Refused — `false`, nothing changed — when the `calls` watches would
    /// change: a context they hold, and the calls already carried, came from
    /// the old ones, and only a re-read can make them right. Adding or
    /// dropping watches of the other lanes always goes through.
    fn retarget(&mut self, watches: Vec<TailWatch>) -> bool {
        fn calls(list: &[TailWatch]) -> Vec<&TailWatch> {
            list.iter().filter(|watch| watch.lane == TailLane::Calls).collect()
        }
        if calls(&self.watches) != calls(&watches) {
            return false;
        }
        self.watches = watches;
        true
    }
}

/// The live session-file tails, keyed by pane id — a shared
/// [`fswatch::WatchRegistry`] like every other watcher family
/// (`HeadWatchers`, `ProjectFsWatchers`), over [`TailPoller`] (see the
/// module doc for why not an OS watcher). The poller's closure owns the
/// tail state via its `Arc`; replace/remove stops the poller and the tail.
#[derive(Default)]
pub struct UsageTails(fswatch::WatchRegistry<TailPoller>);

/// Production poll cadence: two seconds keeps "near-realtime" honest at a
/// negligible one-file stat per tick. Tests pass something tighter.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// A dedicated poll thread for one tail. Dropping it (registry replace or
/// remove) raises the stop flag; the thread exits within one interval.
pub struct TailPoller {
    stop: Arc<AtomicBool>,
    state: Arc<Mutex<TailState>>,
}

impl TailPoller {
    fn retarget(&self, watches: Vec<TailWatch>) -> bool {
        self.state
            .lock()
            .expect("tail state poisoned")
            .retarget(watches)
    }

    fn link(&self, path: PathBuf) -> bool {
        let mut state = self.state.lock().expect("tail state poisoned");
        if state.path != path && !state.linked.contains(&path) {
            state.linked.push(path);
        }
        true
    }
}

impl Drop for TailPoller {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Drain the root file and any subagent transcripts. The flags report
/// replays PER LANE: `root` = the root file re-read from offset 0, `any` =
/// some followed file did — so the deliverer can mark each event by ITS
/// OWN file's fate. One batch-wide flag was tried and reverted: it stamped
/// a fresh root interrupt catch-up whenever a subagent happened to rotate
/// in the same tick, and for an agent whose interrupts reach the host only
/// through its tail lane the Esc was simply lost (review finding).
///
/// A ROOT rotation is a new session generation: the totals restart AND
/// every subagent cursor rewinds, so the subagents' contributions re-fold
/// into the fresh totals instead of silently vanishing from them. A
/// subagent's own solo rotation marks only the `any` flag (its re-folded
/// rows are absorbed by the per-message-id dedup in the totals).
struct DrainReplay {
    root: bool,
    any: bool,
}

fn drain_all(state: &mut TailState) -> (Vec<TailedEvent>, DrainReplay) {
    let (mut events, root_rotated) = drain_file(&state.path, &mut state.root, &state.watches, true);
    // A sibling directory may hold the root file itself (kimi's `agents/`
    // holds `main/wire.jsonl` beside its subagents'): it is read once, as the
    // root.
    let mut contributors: Vec<PathBuf> = state
        .siblings
        .as_deref()
        .map(sibling_paths)
        .unwrap_or_default()
        .into_iter()
        .filter(|path| *path != state.path)
        .collect();
    for path in &state.linked {
        if !contributors.contains(path) {
            contributors.push(path.clone());
        }
    }
    let mut any = root_rotated;
    for path in contributors {
        let cursor = state.subagents.entry(path.clone()).or_default();
        if root_rotated {
            *cursor = TailCursor::default();
        }
        // `root: false` — a subagent's abort is its own, never the pane's.
        let (appended, sub_rotated) = drain_file(&path, cursor, &state.watches, false);
        any = any || sub_rotated;
        events.extend(appended);
    }
    (
        events,
        DrainReplay {
            root: root_rotated,
            any,
        },
    )
}

/// A drain's records split into its calls and everything else.
fn split_calls(events: Vec<TailedEvent>) -> (Vec<TailedEvent>, Vec<TailedEvent>) {
    events
        .into_iter()
        .partition(|event| event.payload["lane"] == "calls")
}

/// One door out of the tailer: every report — live poll or arm-time
/// catch-up — routes identically, so a replayed interrupt can never reach
/// the status lane through a second, unrouted path.
fn deliver_routed(app: &AppHandle, report: Report) {
    match route(report) {
        Routed::Status(status) => {
            log::debug!("usage tail: pane={} status record", status.pane_id);
            let _ = app.emit(AGENT_STATUS_EVENT, &status);
        }
        Routed::Usage(report) => {
            log::debug!(
                "usage tail: pane={} {} event",
                report.pane_id,
                report.payload["event"]["type"]
            );
            let _ = app.emit(USAGE_REPORT_EVENT, &report);
        }
    }
}

/// Start the poll thread for one tail. Delivery is a plain closure so the
/// pipeline is testable without a Tauri app handle. `drain` already
/// no-ops when the file is missing or unchanged, so a tick is one cheap
/// open+stat.
fn spawn_tailer(
    state: Arc<Mutex<TailState>>,
    interval: Duration,
    deliver: impl Fn(Report) + Send + 'static,
) -> Result<TailPoller, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let shared = state.clone();
    thread::Builder::new()
        .name("keepdeck usage tail".to_string())
        .spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                thread::sleep(interval);
                if flag.load(Ordering::Relaxed) {
                    break;
                }
                let Ok(mut s) = state.lock() else { break };
                let agent = s.agent.clone();
                let (events, replay) = drain_all(&mut s);
                // Calls first, each one carried — never collapsed with the
                // gauges below. A rotated file re-read whole carries only
                // what is newer than where the ledger stopped.
                let (calls, events) = split_calls(events);
                for call in calls_since(calls, s.since) {
                    let catch_up = if call.root { replay.root } else { replay.any };
                    deliver(wrap(&s.pane_id, &s.token, &agent, call, catch_up));
                }
                // A rotated root file was re-read whole: its status records
                // are a replay, and leave as ONE reconcile of the last of
                // each — the same summary an arm sends.
                let replayed_status = if replay.root {
                    last_status_of_each(&events, &s.watches)
                } else {
                    Vec::new()
                };
                let mut status = Vec::new();
                for event in drop_superseded(events, &s.watches) {
                    // A subagent transcript's turn edges are the subagent's
                    // own story: pane-level status reads only ROOT markers.
                    // Its NUMBERS still count, which is why this drops the
                    // record rather than the whole file's contribution.
                    if !event.root && event.payload["lane"] == "status" {
                        continue;
                    }
                    // A rotated file was re-read WHOLE: those events are a
                    // replay wearing the poller's clothes, and must say so
                    // — catch-up is what keeps a historical interrupt from
                    // firing as if it just happened. Marked by the event's
                    // OWN file, so a subagent's rotation can never cost a
                    // fresh root Esc its delivery.
                    let catch_up = if event.root { replay.root } else { replay.any };
                    let is_status = event.payload["lane"] == "status";
                    let replay_context = event.payload["replayContext"] == true;
                    if is_status && catch_up && !replay_context {
                        continue; // carried by the reconcile below
                    }
                    let report = wrap(&s.pane_id, &s.token, &agent, event, catch_up);
                    if is_status && !catch_up {
                        status.push(report);
                    } else {
                        deliver(report);
                    }
                }
                if let Some(report) = batch_status(status) {
                    deliver(report);
                }
                let reconcile: Vec<Report> = replayed_status
                    .into_iter()
                    .map(|event| wrap(&s.pane_id, &s.token, &agent, event, true))
                    .collect();
                if let Some(report) = batch_status(reconcile) {
                    deliver(report);
                }
            }
        })
        .map_err(|e| format!("usage tail thread failed to start: {e}"))?;
    Ok(TailPoller {
        stop,
        state: shared,
    })
}

/// Everything the webview says about one tail as it arms it.
///
/// One argument rather than five, because it is one thing: where the session
/// is written, who it belongs to, and what its agent asked to have carried
/// out of it. Nothing here is derived on this side — every field is an
/// answer only the other side has.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailArming {
    path: String,
    /// The pane's spawn-plan secret, so tailer reports ride the reporter
    /// envelope's verification path.
    token: String,
    agent: String,
    watches: Vec<TailWatch>,
    siblings: Option<String>,
    /// From when (unix ms) the calls in the file are not booked yet — the
    /// usage ledger's answer for this session. Absent carries every call.
    #[serde(default)]
    since: Option<f64>,
}

/// Follow one pane's session file, emitting its current usage state right
/// away. Idempotent per pane: a rebind (new session, new file) replaces the
/// old tail. `(async)` — the catch-up drain reads a whole session file.
#[tauri::command(async)]
pub fn usage_watch_session_file(
    app: AppHandle,
    tails: State<UsageTails>,
    pane_id: String,
    tail: TailArming,
) -> Result<(), String> {
    // Replace-first: the OLD tail must be gone before the new watcher arms,
    // or a same-path rebind briefly runs two tails and duplicates events.
    tails.0.remove(&pane_id);

    let path = tail.path;
    let agent = tail.agent;
    let state = Arc::new(Mutex::new(TailState {
        path: PathBuf::from(&path),
        pane_id: pane_id.clone(),
        token: tail.token,
        agent: agent.clone(),
        root: TailCursor::default(),
        watches: tail.watches,
        siblings: tail.siblings.map(PathBuf::from),
        linked: Vec::new(),
        subagents: HashMap::new(),
        since: tail.since,
    }));

    // Watcher FIRST, catch-up second: an append landing during the catch-up
    // drain fires an event that re-drains whatever the catch-up hasn't
    // consumed (the offset is shared) — nothing is lost in the gap. The
    // reverse order lost any append between drain and arm until the NEXT
    // fs event. Lines the watcher wins ride as live reports; the catch-up
    // summary is marked catchUp so a replay can never outrank them.
    let emitter = app.clone();
    let watcher = spawn_tailer(state.clone(), POLL_INTERVAL, move |payload| {
        deliver_routed(&emitter, payload);
    })?;
    let (caught_up, reconciled, position) = {
        let mut s = state.lock().expect("tail state poisoned");
        let (drained, _) = drain_all(&mut s);
        let (calls, drained) = split_calls(drained);
        let reconcile: Vec<Report> = last_status_of_each(&drained, &s.watches)
            .into_iter()
            .map(|event| wrap(&s.pane_id, &s.token, &agent, event, true))
            .collect();
        let reconciled = reconcile.len();
        // The gauges are a state: the last reading of each watch is all of
        // it. Calls are not — every one since the ledger stopped is a call it
        // has not booked, so each travels; the ledger books each once.
        let mut events = last_of_each(drained, &s.watches);
        events.extend(calls_since(calls, s.since));
        let count = events.len();
        for event in events {
            let report = wrap(&s.pane_id, &s.token, &agent, event, true);
            // Through the SAME router as the live path. Opted-in decoder
            // metadata is marked context-only there.
            deliver_routed(&app, report);
        }
        // The file's latest turn boundaries, as one reconcile: a turn that
        // ended before this tail armed — while the pane's hook had already
        // said "working" — must still be able to end. The tracker uses a
        // reconcile only to END a turn it shows running, never to start one.
        if let Some(report) = batch_status(reconcile) {
            deliver_routed(&app, report);
        }
        // Where the follower now stands, against how long the file is: a
        // tail that later "stops" can be told apart from one that never
        // got past its start.
        let size = std::fs::metadata(&s.path).map(|m| m.len()).ok();
        (count, reconciled, (s.root.offset, size))
    };
    // One line per arm — the difference between "tail broken" and "tail
    // never armed" cost a blind debugging session once.
    log::info!(
        "usage tail: pane={pane_id} agent={agent} file={:?} at={}/{} catch-up={caught_up} reconcile={reconciled}",
        PathBuf::from(&path).file_name().unwrap_or_default(),
        position.0,
        position.1.map_or_else(|| "?".to_string(), |size| size.to_string()),
    );
    tails.0.insert(pane_id, watcher);
    Ok(())
}

/// Follow another store of the session a pane's tail follows — a store a
/// record named (codex's subagent thread), found by the agent's plugin. Read
/// with the pane's own from the next poll: its calls from `since`, its status
/// never (a subagent's turns are its own). `false` when the pane has no tail
/// to add it to; adding a file twice is a no-op.
#[tauri::command]
pub fn usage_link_session_file(tails: State<UsageTails>, pane_id: String, path: String) -> bool {
    tails
        .0
        .with(&pane_id, |tail| tail.link(PathBuf::from(path)))
        .unwrap_or(false)
}

/// Change what a pane's armed tail carries, from where it stands — the
/// session file is not read again. `false` when there is no tail to change
/// (an arm still on its way holds the watches it was sent) or the tail
/// refused (see [`TailState::retarget`]): the caller arms afresh.
#[tauri::command]
pub fn usage_retarget_session_file(
    tails: State<UsageTails>,
    pane_id: String,
    watches: Vec<TailWatch>,
) -> bool {
    tails
        .0
        .with(&pane_id, |tail| tail.retarget(watches))
        .unwrap_or(false)
}

/// Stop following a pane's session file (pane closed / rebind cleanup).
/// Unknown panes are a no-op.
#[tauri::command]
pub fn usage_unwatch_session_file(tails: State<UsageTails>, pane_id: String) {
    tails.0.remove(&pane_id);
}

/// One carried record of a cold read, with the instant it claims for itself.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColdRecord {
    event: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_at: Option<dialects::SourceTimestamp>,
}

/// What one cold read found, and how old the file it found it in is.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColdRead {
    records: Vec<ColdRecord>,
    mtime_ms: u64,
}

/// Read a store ONCE, from the beginning, with nobody following it.
///
/// The boot catch-up: an agent that also runs outside KeepDeck can have
/// spent quota this deck never saw, so its own files can know fresher limits
/// than a persisted snapshot. Which files those are is the agent's to say —
/// this used to walk one particular CLI's day-partitioned sessions tree,
/// matching one particular record kind, in the side that is not supposed to
/// know either. It is handed a path and a declaration now.
///
/// The answer is the same collapse a live arming produces — the last record
/// of each watch — so one normalizer reads a cold store and a live one
/// without being told which it is looking at. `None` when the file carries
/// nothing the declaration asked for, which is how a caller knows to try the
/// next candidate.
#[tauri::command(async)]
pub fn usage_read_store_cold(path: String, watches: Vec<TailWatch>) -> Option<ColdRead> {
    let path = PathBuf::from(path);
    let mtime_ms = std::fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)?;
    // A cold read needs no TailState: one cursor from zero, because this
    // file IS the whole session it describes.
    let mut cursor = TailCursor::default();
    let (drained, _) = drain_file(&path, &mut cursor, &watches, true);
    let records: Vec<ColdRecord> = last_of_each(drained, &watches)
        .into_iter()
        .map(|event| ColdRecord {
            event: event.payload,
            source_at: event.source_at,
        })
        .collect();
    (!records.is_empty()).then_some(ColdRead { records, mtime_ms })
}

// The TUI-resume fallback resolver used to be a command here. It named an
// agent in the host's own command surface and knew where that agent keeps
// its files; both are the agent's business, and its plugin was already
// walking the same tree for its history browser. The dialect answers now.

#[cfg(test)]
mod tests {
    use super::dialects::*;
    use super::*;

    fn equals(key: &str, value: &str) -> RecordMatch {
        RecordMatch {
            key: key.into(),
            equals: Some(value.into()),
        }
    }

    /// The least specific watch there is: carry anything with a `type`,
    /// keep that alone. Enough for the tests that are about FOLLOWING a
    /// file rather than about what its records mean.
    fn any_typed_record() -> Vec<TailWatch> {
        vec![TailWatch {
            clauses: vec![RecordMatch {
                key: "type".into(),
                equals: None,
            }],
            keep: vec!["type".into()],
            lane: TailLane::Usage,
            replay_context: false,
            context: false,
            links: false,
        }]
    }

    fn watch(clauses: Vec<RecordMatch>, keep: &[&str], lane: TailLane) -> TailWatch {
        TailWatch {
            clauses,
            keep: keep.iter().map(|key| key.to_string()).collect(),
            lane,
            replay_context: false,
            context: false,
            links: false,
        }
    }

    /// A kimi-shaped declaration: every usage record is a call, and the
    /// request before it names the model.
    fn kimi_calls() -> Vec<TailWatch> {
        let mut request = watch(vec![equals("type", "llm.request")], &["model"], TailLane::Calls);
        request.context = true;
        vec![request, watch(vec![equals("type", "usage.record")], &["type", "usage"], TailLane::Calls)]
    }

    /// A claude-shaped declaration: every assistant row is a call (a
    /// message restated over several rows is booked once by the ledger).
    fn claude_calls() -> Vec<TailWatch> {
        vec![watch(
            vec![equals("type", "assistant")],
            &["message.id", "message.usage"],
            TailLane::Calls,
        )]
    }

    /// The interrupt marker, on the status lane — declared AFTER a usage
    /// watch wherever both are used, since the first match carries.
    fn marker_watch() -> TailWatch {
        watch(
            vec![RecordMatch {
                key: "interruptedMessageId".into(),
                equals: None,
            }],
            &["interruptedMessageId"],
            TailLane::Status,
        )
    }

    fn calls_of(events: &[TailedEvent]) -> Vec<&TailedEvent> {
        events.iter().filter(|event| event.payload["lane"] == "calls").collect()
    }

    /// Root-only drain, as the pre-split suite spelled it. Every fixture
    /// here either has no subagents dir or wants them too — `drain_all`
    /// answers both.
    fn drain(state: &mut TailState) -> Vec<TailedEvent> {
        drain_all(state).0
    }

    /// The pre-split wire wrapper, kept as a test-local shim so the suite's
    /// many call sites read as before; production goes through [`wrap`].
    fn report(state: &TailState, event: TailedEvent, catch_up: bool) -> Report {
        wrap(&state.pane_id, &state.token, &state.agent, event, catch_up)
    }
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::test_support::*;

    fn tail(path: PathBuf) -> TailState {
        TailState {
            path,
            pane_id: "pane-1".into(),
            token: "tok".into(),
            agent: "codex".into(),
            root: TailCursor::default(),
            watches: any_typed_record(),
            siblings: None,
            linked: Vec::new(),
            subagents: HashMap::new(),
            since: None,
        }
    }

    /// A tail whose dialect named a directory of contributing files. The
    /// rule turning a store's path into that directory is the agent's; here
    /// it arrives already applied, which is exactly how production gets it.
    fn tail_with_siblings(path: PathBuf, siblings: PathBuf) -> TailState {
        TailState {
            agent: "claude".into(),
            siblings: Some(siblings),
            ..tail(path)
        }
    }

    // A subagent transcript's interrupt marker must never become the PANE's
    // interrupt: drain_all tags subagent events, and the poller drops the
    // non-root markers before delivery.
    #[test]
    fn subagent_interrupts_are_tagged_off_root() {
        let dir = temp_dir();
        let path = dir.join("session-sub.jsonl");
        fs::write(&path, format!("{CLAUDE_ASSISTANT_LINE}\n")).unwrap();
        let subagents = dir.join("session-sub/subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(
            subagents.join("agent-a.jsonl"),
            "{\"type\":\"user\",\"interruptedMessageId\":\"msg-9\",\"message\":{\"role\":\"user\",\"content\":[]}}\n",
        )
        .unwrap();

        let mut state = tail_with_siblings(path, subagents.clone());
        // The marker reaches this side only because the pane's dialect asked
        // for it — and the numbers watch is declared first, since the first
        // match carries.
        let mut watches = claude_calls();
        watches.push(marker_watch());
        state.watches = watches;

        let (drained, _) = drain_all(&mut state);
        let marker = drained
            .iter()
            .find(|event| event.payload["lane"] == "status")
            .expect("subagent marker drained");
        assert!(!marker.root, "a subagent marker must not read as root");
        assert!(
            calls_of(&drained).iter().all(|event| event.root),
            "the root transcript's own rows keep their root tag"
        );
        fs::remove_dir_all(&dir).ok();
    }

    // A truncated/replaced session file re-reads from offset 0: that batch
    // is a REPLAY and drain_all must say so, or every historical abort in
    // the file would fire again as a live interrupt.
    #[test]
    fn a_rotated_root_drain_reports_itself_as_replay() {
        let dir = temp_dir();
        let path = dir.join("rollout-rot.jsonl");
        fs::write(&path, format!("{CLAUDE_ASSISTANT_LINE}\n")).unwrap();
        let mut state = tail(path.clone());
        let (_, replay) = drain_all(&mut state);
        assert!(!replay.root, "first drain is a plain read");

        // Replace the file with SHORTER content — len < offset.
        fs::write(&path, "{}\n").unwrap();
        let (_, replay) = drain_all(&mut state);
        assert!(replay.root, "a shrunken file is a rotation, not appends");
        fs::remove_dir_all(&dir).ok();
    }

    // A root rotation is a new session generation: the subagent cursors
    // rewind with the totals, so their contributions re-fold instead of
    // silently vanishing from the fresh sums.
    #[test]
    fn a_root_rotation_rewinds_subagent_cursors() {
        let dir = temp_dir();
        let path = dir.join("session-gen.jsonl");
        fs::write(&path, format!("{CLAUDE_ASSISTANT_LINE}\n")).unwrap();
        let subagents = dir.join("session-gen/subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(
            subagents.join("agent-a.jsonl"),
            format!("{CLAUDE_ASSISTANT_LINE}\n"),
        )
        .unwrap();

        let mut state = tail_with_siblings(path.clone(), subagents.clone());
        let (first, _) = drain_all(&mut state);
        assert_eq!(first.len(), 2, "root row + subagent row");
        assert!(drain_all(&mut state).0.is_empty(), "all consumed");

        // The root rotates (shorter file, same subagent content).
        fs::write(&path, "{}\n").unwrap();
        let (replayed_events, replay) = drain_all(&mut state);
        assert!(replay.root);
        assert!(replay.any);
        assert!(
            replayed_events.iter().any(|event| !event.root),
            "the subagent's rows re-drain into the new generation"
        );
        fs::remove_dir_all(&dir).ok();
    }

    // A subagent's own rotation replays ITS history — but must not cost
    // the ROOT lane anything: a fresh root Esc in the same tick still
    // delivers live (the tail is claude's only interrupt source).
    #[test]
    fn a_subagent_rotation_marks_only_its_own_lane() {
        let dir = temp_dir();
        let path = dir.join("session-solo.jsonl");
        fs::write(&path, format!("{CLAUDE_ASSISTANT_LINE}\n")).unwrap();
        let subagents = dir.join("session-solo/subagents");
        fs::create_dir_all(&subagents).unwrap();
        let sub = subagents.join("agent-a.jsonl");
        fs::write(
            &sub,
            format!("{CLAUDE_ASSISTANT_LINE}\n{CLAUDE_ASSISTANT_LINE}\n"),
        )
        .unwrap();

        let mut state = tail_with_siblings(path.clone(), subagents.clone());
        drain_all(&mut state);

        // Only the SUBAGENT file shrinks; the root is untouched.
        fs::write(&sub, format!("{CLAUDE_ASSISTANT_LINE}\n")).unwrap();
        let (events, replay) = drain_all(&mut state);
        assert!(replay.any, "the subagent's replay must be marked");
        assert!(!replay.root, "the root lane stays live — its Esc must land");
        assert!(events.iter().all(|event| !event.root));
        fs::remove_dir_all(&dir).ok();
    }

    // A rewritten file is read again from the top — every call in it, which
    // the ledger books once — and its context starts over: the new file has
    // not yet said what its calls run on.
    #[test]
    fn a_rotation_re_reads_every_call_and_forgets_the_files_context() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let mut state = tail(path.clone());
        state.watches = kimi_calls();

        fs::write(&path, format!("{LLM_REQUEST_LINE}\n{USAGE_RECORD_LINE}\n{USAGE_RECORD_LINE}\n")).unwrap();
        let events = drain(&mut state);
        assert_eq!(events.len(), 2, "the request is context, not a call");
        assert!(events.iter().all(|event| event.payload["context"]["model"] == "kimi-code/k3"));
        assert!(!events[0].payload.to_string().contains("SECRET"), "a context keeps only what it names");

        fs::write(&path, format!("{USAGE_RECORD_LINE}\n")).unwrap();
        let events = drain(&mut state);
        assert_eq!(events.len(), 1);
        assert!(events[0].payload.get("context").is_none(), "the old file's context is gone");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_retarget_reads_on_from_the_cursor() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let mut state = tail(path.clone());
        state.watches = kimi_calls();
        state.watches.push(marker_watch());
        fs::write(&path, format!("{LLM_REQUEST_LINE}\n{USAGE_RECORD_LINE}\n")).unwrap();
        assert_eq!(drain(&mut state).len(), 1);

        // The status lane leaves; the calls read on from where they were,
        // their context with them.
        assert!(state.retarget(kimi_calls()));
        assert_eq!(state.watches, kimi_calls());
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{USAGE_RECORD_LINE}").unwrap();
        let events = drain(&mut state);
        assert_eq!(events.len(), 1, "only the appended line is read");
        assert_eq!(events[0].payload["context"]["model"], "kimi-code/k3");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_retarget_that_would_change_the_calls_is_refused() {
        let mut state = tail(PathBuf::from("/nowhere.jsonl"));
        state.watches = kimi_calls();
        let mut gone = kimi_calls();
        gone.pop();
        for watches in [gone, claude_calls(), vec![marker_watch()]] {
            assert!(!state.retarget(watches));
            assert_eq!(state.watches, kimi_calls(), "nothing changed");
        }
    }

    // The ledger knows where it stopped: an arm carries the calls from there
    // on, never the file's whole history again.
    #[test]
    fn an_arm_carries_every_call_since_the_ledger_stopped_and_no_more() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let mut state = tail(path.clone());
        state.watches = kimi_calls();
        let record = |time: u64| {
            format!(r#"{{"type":"usage.record","usage":{{"inputOther":1,"output":1}},"time":{time}}}"#)
        };
        fs::write(&path, format!("{}\n{}\n{}\n", record(100), record(200), record(300))).unwrap();

        let (calls, rest) = split_calls(drain(&mut state));
        assert!(rest.is_empty());
        assert!(last_of_each(calls.clone(), &state.watches).is_empty(), "no call is summarised away");
        let kept = calls_since(calls, Some(200.0));
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].source_at, Some(SourceTimestamp::UnixMillis(200)));

        fs::remove_dir_all(&dir).ok();
    }

    // A message written as several rows travels as several calls: each one
    // restates the message, and the ledger books only what grew.
    #[test]
    fn every_row_of_a_restated_message_is_carried() {
        let dir = temp_dir();
        let path = dir.join("claude.jsonl");
        let mut state = tail(path.clone());
        state.watches = claude_calls();
        let repeated =
            CLAUDE_ASSISTANT_LINE.replace(r#""output_tokens":30"#, r#""output_tokens":45"#);
        fs::write(&path, format!("{CLAUDE_ASSISTANT_LINE}\n{repeated}\n")).unwrap();

        let events = drain(&mut state);
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].payload["record"]["message.usage"]["output_tokens"], 45);
        assert!(events.iter().all(|event| !event.payload.to_string().contains("SECRET")));

        fs::remove_dir_all(&dir).ok();
    }

    // A store a record named joins the pane's tail: read from the next
    // poll, under the same session, never twice.
    #[test]
    fn a_linked_store_is_read_with_the_panes_own() {
        let dir = temp_dir();
        let path = dir.join("rollout-parent.jsonl");
        let child = dir.join("rollout-child.jsonl");
        fs::write(&path, format!("{USAGE_RECORD_LINE}\n")).unwrap();
        fs::write(&child, format!("{USAGE_RECORD_LINE}\n{USAGE_RECORD_LINE}\n")).unwrap();
        let mut state = tail(path.clone());
        state.watches = kimi_calls();
        assert_eq!(drain(&mut state).len(), 1);

        state.linked.push(child.clone());
        let events = drain(&mut state);
        assert_eq!(events.len(), 2, "the linked store's calls");
        assert!(events.iter().all(|event| !event.root));
        assert_eq!(
            events[0].source_ref.as_ref().map(|r| r.file.clone()),
            Some(child.to_string_lossy().into_owned())
        );
        assert!(drain(&mut state).is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    // Siblings are looked for below the named directory too: claude nests a
    // workflow's agents, kimi gives each subagent a directory of its own.
    #[test]
    fn sibling_files_are_found_in_nested_directories() {
        let dir = temp_dir();
        let path = dir.join("session.jsonl");
        fs::write(&path, "").unwrap();
        let agents = dir.join("session/agents");
        fs::create_dir_all(agents.join("sub-1")).unwrap();
        fs::create_dir_all(agents.join("main")).unwrap();
        fs::write(agents.join("sub-1/wire.jsonl"), format!("{USAGE_RECORD_LINE}\n")).unwrap();
        fs::write(agents.join("notes.txt"), "not a store").unwrap();
        let mut state = tail_with_siblings(path, agents.clone());
        state.watches = kimi_calls();
        assert_eq!(drain(&mut state).len(), 1);

        // The root may sit inside the sibling directory: read once, as root.
        let main = agents.join("main/wire.jsonl");
        fs::write(&main, format!("{USAGE_RECORD_LINE}\n")).unwrap();
        let mut state = tail_with_siblings(main, agents);
        state.watches = kimi_calls();
        let events = drain(&mut state);
        assert_eq!(events.len(), 2, "main once, the subagent once");
        assert_eq!(events.iter().filter(|event| event.root).count(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claude_catch_up_includes_subagent_transcripts() {
        let dir = temp_dir();
        let path = dir.join("session-1.jsonl");
        let subagents = dir.join("session-1/subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(&path, format!("{CLAUDE_ASSISTANT_LINE}\n")).unwrap();
        let subagent = CLAUDE_ASSISTANT_LINE
            .replace("msg-1", "msg-subagent")
            .replace(r#""input_tokens":12"#, r#""input_tokens":2"#)
            .replace(r#""output_tokens":30"#, r#""output_tokens":7"#)
            .replace(
                r#""cache_read_input_tokens":40000"#,
                r#""cache_read_input_tokens":100"#,
            )
            .replace(
                r#""cache_creation_input_tokens":900"#,
                r#""cache_creation_input_tokens":3"#,
            );
        fs::write(subagents.join("agent-a.jsonl"), format!("{subagent}\n")).unwrap();

        let mut state = tail_with_siblings(path, subagents.clone());
        state.watches = claude_calls();
        let (drained, _) = drain_all(&mut state);
        assert_eq!(drained.len(), 2);
        assert!(
            drained
                .iter()
                .all(|event| !event.payload.to_string().contains("SECRET")),
            "root and subagent transcript content must stay private"
        );
        // A subagent's calls are the session's spend too — only its turn
        // edges are its own.
        let subagent = drained.iter().find(|event| !event.root).expect("the subagent's call");
        assert_eq!(subagent.payload["record"]["message.id"], "msg-subagent");
        assert_eq!(subagent.payload["record"]["message.usage"]["output_tokens"], 7);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claude_discovers_a_subagent_file_created_after_arming() {
        let dir = temp_dir();
        let path = dir.join("session-late.jsonl");
        fs::write(&path, format!("{CLAUDE_ASSISTANT_LINE}\n")).unwrap();
        let subagents = dir.join("session-late/subagents");
        // Named at arming, and the directory does not exist yet — which is
        // the point: it appears when the first subagent starts.
        let mut state = tail_with_siblings(path, subagents.clone());
        state.watches = claude_calls();
        drain_all(&mut state);

        fs::create_dir_all(&subagents).unwrap();
        let subagent = CLAUDE_ASSISTANT_LINE
            .replace("msg-1", "msg-late")
            .replace(r#""output_tokens":30"#, r#""output_tokens":5"#);
        fs::write(subagents.join("agent-late.jsonl"), format!("{subagent}\n")).unwrap();

        let (appended, _) = drain_all(&mut state);
        assert_eq!(appended.len(), 1);
        assert_eq!(appended[0].payload["record"]["message.id"], "msg-late");
        assert!(drain_all(&mut state).0.is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_cold_read_answers_with_the_same_collapse_a_live_arming_does() {
        // The boot catch-up. What comes back must be indistinguishable from
        // what a live tail delivers, because ONE normalizer reads both — and
        // it is never told which it is looking at.
        let dir = temp_dir();
        let path = dir.join("cold.jsonl");
        let gauges = || vec![watch(vec![equals("type", "usage.record")], &["type", "usage"], TailLane::Usage)];
        let last = USAGE_RECORD_LINE.replace(r#""inputOther":1200"#, r#""inputOther":7"#);
        fs::write(&path, format!("{USAGE_RECORD_LINE}\n{last}\n")).unwrap();
        set_mtime(&path, 2_000);

        let found = usage_read_store_cold(path.to_string_lossy().into(), gauges()).expect("read");
        assert_eq!(found.mtime_ms, 2_000_000);
        assert_eq!(found.records.len(), 1, "the last record of the one watch");
        assert_eq!(found.records[0].event["record"]["usage"]["inputOther"], 7);
        assert_eq!(
            found.records[0].source_at,
            Some(dialects::SourceTimestamp::UnixMillis(1_784_800_000_000))
        );

        // A store carrying nothing the declaration asked for is how the
        // caller learns to try the next candidate.
        let empty = dir.join("empty.jsonl");
        fs::write(&empty, format!("{LLM_REQUEST_LINE}\n")).unwrap();
        assert_eq!(
            usage_read_store_cold(empty.to_string_lossy().into(), gauges()),
            None
        );
        // So is a file that is not there at all.
        assert_eq!(
            usage_read_store_cold(
                dir.join("missing.jsonl").to_string_lossy().into(),
                gauges()
            ),
            None
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reports_carry_the_agent_tag_and_the_catch_up_mark() {
        let watches = any_typed_record();
        let carry = |line: &[u8]| {
            watched_events(line, &watches, &mut None)
                .into_iter()
                .next()
                .expect("carried")
        };

        let mut state = tail(PathBuf::from("/x/rollout.jsonl"));
        let mut event = carry(TURN_CONTEXT_LINE.as_bytes());
        event.source_mtime_ms = Some(1_234);
        let wrapped = report(&state, event, false);
        assert_eq!(wrapped.pane_id, "pane-1");
        assert_eq!(wrapped.token, "tok");
        assert_eq!(wrapped.payload["agent"], "codex");
        assert_eq!(wrapped.payload["event"]["record"]["type"], "turn_context");
        assert_eq!(wrapped.payload["catchUp"], false);
        assert_eq!(wrapped.payload["sourceAt"], SOURCE_ISO);
        assert_eq!(wrapped.payload["sourceMtimeMs"], 1_234);

        // The agent tag is what the tail was ARMED with, never anything read
        // out of the record — and a store that stamps unix millis keeps its
        // own instant just the same.
        state.agent = "kimi".into();
        let wrapped = report(&state, carry(USAGE_RECORD_LINE.as_bytes()), true);
        assert_eq!(wrapped.payload["agent"], "kimi");
        assert_eq!(wrapped.payload["catchUp"], true);
        assert_eq!(wrapped.payload["sourceAt"], 1_784_800_000_000_u64);

        state.agent = "claude".into();
        let wrapped = report(&state, carry(CLAUDE_ASSISTANT_LINE.as_bytes()), true);
        assert_eq!(wrapped.payload["agent"], "claude");
        assert_eq!(wrapped.payload["event"]["record"]["type"], "assistant");
    }

    #[test]
    fn a_missing_event_timestamp_falls_back_to_the_file_mtime() {
        let dir = temp_dir();
        let path = dir.join("rollout-no-timestamp.jsonl");
        let without_timestamp =
            TOKEN_COUNT_LINE.replacen(&format!(r#""timestamp":"{SOURCE_ISO}","#), "", 1);
        fs::write(&path, format!("{without_timestamp}\n")).unwrap();
        set_mtime(&path, 1_234);

        let event = drain(&mut tail(path)).pop().expect("usage event");
        assert_eq!(
            event.source_at,
            Some(SourceTimestamp::UnixMillis(1_234_000))
        );
        assert_eq!(event.source_mtime_ms, Some(1_234_000));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_malformed_event_timestamp_keeps_file_mtime_as_a_separate_fallback() {
        let dir = temp_dir();
        let path = dir.join("rollout-malformed-timestamp.jsonl");
        let malformed = TOKEN_COUNT_LINE.replace(SOURCE_ISO, "not-an-iso-time");
        fs::write(&path, format!("{malformed}\n")).unwrap();
        set_mtime(&path, 1_234);

        let event = drain(&mut tail(path.clone())).pop().expect("usage event");
        assert_eq!(
            event.source_at,
            Some(SourceTimestamp::Iso("not-an-iso-time".into()))
        );
        assert_eq!(event.source_mtime_ms, Some(1_234_000));
        let wrapped = report(&tail(path), event, true);
        assert_eq!(wrapped.payload["sourceAt"], "not-an-iso-time");
        assert_eq!(wrapped.payload["sourceMtimeMs"], 1_234_000_u64);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn kimi_wire_drains_through_the_same_incremental_reader() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let mut state = tail(path.clone());

        fs::write(&path, format!("{LLM_REQUEST_LINE}\n{USAGE_RECORD_LINE}\n")).unwrap();
        let events = drain(&mut state);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].payload["record"]["type"], "llm.request");
        assert_eq!(events[1].payload["record"]["type"], "usage.record");
        assert!(
            !events[0].payload.to_string().contains("SECRET"),
            "a prompt must not ride out of the store"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tailer_batches_only_live_root_status_in_file_order() {
        let dir = temp_dir();
        let path = dir.join("session.jsonl");
        let siblings = dir.join("subagents");
        fs::create_dir_all(&siblings).unwrap();
        let mut state = tail_with_siblings(path.clone(), siblings.clone());
        state.watches = serde_json::from_value(serde_json::json!([
            { "match": [{ "key": "type", "equals": "status" }],
              "keep": ["type", "edge"], "lane": "status" },
            { "match": [{ "key": "type", "equals": "usage" }],
              "keep": ["type"], "lane": "usage" }
        ]))
        .unwrap();
        // Hold the mutex while writing: both records must be visible in ONE
        // poll, without relying on scheduling or a close notification.
        let state = Arc::new(Mutex::new(state));
        let guard = state.lock().unwrap();
        let (tx, rx) = mpsc::channel();
        let watcher = spawn_tailer(state.clone(), Duration::from_millis(20), move |r| {
            let _ = tx.send(route(r));
        })
        .unwrap();
        fs::write(
            &path,
            concat!(
                "{\"type\":\"status\",\"edge\":\"abort\",\"private\":\"SECRET\"}\n",
                "{\"type\":\"usage\"}\n",
                "{\"type\":\"status\",\"edge\":\"accepted\"}\n"
            ),
        )
        .unwrap();
        fs::write(
            siblings.join("agent.jsonl"),
            "{\"type\":\"status\",\"edge\":\"child-abort\"}\n",
        )
        .unwrap();
        drop(guard);
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            Routed::Usage(_)
        ));
        let Routed::Status(report) = rx.recv_timeout(Duration::from_secs(10)).unwrap() else {
            panic!("expected atomic status delivery")
        };
        assert_eq!(report.payload["kind"], "store.batch");
        assert_eq!(
            report.payload["records"],
            serde_json::json!([
                { "type": "status", "edge": "abort" },
                { "type": "status", "edge": "accepted" }
            ])
        );
        assert_eq!(report.pane_id, "pane-1");
        assert_eq!(report.token, "tok");
        // Rotation replays history: never as live status — as a reconcile.
        let guard = state.lock().unwrap();
        fs::write(&path, "{\"type\":\"status\",\"edge\":\"old\"}\n").unwrap();
        drop(guard);
        let Routed::Status(replayed) = rx.recv_timeout(Duration::from_secs(10)).unwrap() else {
            panic!("a rotated file's status is a reconcile")
        };
        assert_eq!(replayed.payload["reconcile"], true);
        assert_eq!(replayed.payload["record"], serde_json::json!({ "type": "status", "edge": "old" }));
        assert!(rx.try_recv().is_err(), "no off-root status may escape");
        drop(watcher);
        fs::remove_dir_all(&dir).ok();
    }

    // task-462: a turn that ended before the tail armed — its hook had
    // already said "working" — reaches the channel as ONE reconcile carrying
    // the file's latest boundaries in file order, where it used to be lost.
    #[test]
    fn an_arm_after_a_finished_turn_carries_its_ending_as_one_reconcile() {
        let dir = temp_dir();
        let path = dir.join("session.jsonl");
        let mut state = tail(path.clone());
        state.watches = serde_json::from_value(serde_json::json!([
            { "match": [{ "key": "type", "equals": "prompt" }], "keep": ["type", "at"], "lane": "status" },
            { "match": [{ "key": "type", "equals": "ended" }], "keep": ["type", "at"], "lane": "status" },
            { "match": [{ "key": "type", "equals": "usage" }], "keep": ["type"], "lane": "usage" }
        ]))
        .unwrap();
        fs::write(
            &path,
            concat!(
                "{\"type\":\"prompt\",\"at\":1}\n",
                "{\"type\":\"ended\",\"at\":2}\n",
                "{\"type\":\"prompt\",\"at\":3,\"text\":\"SECRET\"}\n",
                "{\"type\":\"usage\"}\n",
                "{\"type\":\"ended\",\"at\":4}\n"
            ),
        )
        .unwrap();
        // The arm's own steps, minus the AppHandle.
        let (drained, _) = drain_all(&mut state);
        let reconcile: Vec<Report> = last_status_of_each(&drained, &state.watches)
            .into_iter()
            .map(|event| report(&state, event, true))
            .collect();
        let Some(Routed::Status(sent)) = batch_status(reconcile).map(route) else {
            panic!("the finished turn's boundaries reach the status channel")
        };
        assert_eq!(sent.payload["reconcile"], true);
        assert_eq!(sent.payload["kind"], "store.batch");
        assert_eq!(
            sent.payload["records"],
            serde_json::json!([{ "type": "prompt", "at": 3 }, { "type": "ended", "at": 4 }])
        );
        assert!(!sent.payload.to_string().contains("SECRET"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tailer_delivers_appends_from_an_open_handle_without_close() {
        // The real CLIs keep their session file OPEN for the whole run and
        // append+flush without ever closing — the one pattern the e2e test
        // below (which drops its handle) never exercised.
        let dir = temp_dir();
        let path = dir.join("rollout-openhandle.jsonl");
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        let state = Arc::new(Mutex::new(tail(path)));
        let (tx, rx) = mpsc::channel::<Report>();
        let _watcher = spawn_tailer(state, Duration::from_millis(150), move |r| {
            let _ = tx.send(r);
        })
        .expect("watch");

        writeln!(file, "{TOKEN_COUNT_LINE}").unwrap();
        file.flush().unwrap();
        // NO drop(file) — the handle stays open like a live CLI's.

        let delivered = rx.recv_timeout(Duration::from_secs(10));
        assert!(
            delivered.is_ok(),
            "append from a still-open handle must deliver"
        );
        drop(file);
        fs::remove_dir_all(&dir).ok();
    }

    // A gauge read three times in one tick is one reading — the last.
    #[test]
    fn tailer_delivers_one_gauge_report_for_a_run_of_readings() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        fs::write(&path, "").unwrap();
        let mut state = tail(path.clone());
        state.watches = vec![watch(vec![equals("type", "usage.record")], &["usage"], TailLane::Usage)];
        let state = Arc::new(Mutex::new(state));
        let (tx, rx) = mpsc::channel::<Report>();
        let _watcher = spawn_tailer(state, Duration::from_millis(150), move |r| {
            let _ = tx.send(r);
        })
        .expect("watch");

        let last = USAGE_RECORD_LINE.replace(r#""inputOther":1200"#, r#""inputOther":7"#);
        fs::write(&path, format!("{USAGE_RECORD_LINE}\n{USAGE_RECORD_LINE}\n{last}\n")).unwrap();
        let report = rx.recv_timeout(Duration::from_secs(10)).expect("a report");
        assert_eq!(report.payload["event"]["record"]["usage"]["inputOther"], 7, "the last reading");
        assert!(
            rx.recv_timeout(Duration::from_millis(600)).is_err(),
            "and is the only one"
        );
        fs::remove_dir_all(&dir).ok();
    }

    // A call read three times in one tick is three calls: each one travels,
    // with its place in the store.
    #[test]
    fn tailer_delivers_every_call_of_a_tick() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        fs::write(&path, "").unwrap();
        let mut state = tail(path.clone());
        state.watches = kimi_calls();
        let state = Arc::new(Mutex::new(state));
        let (tx, rx) = mpsc::channel::<Report>();
        let _watcher = spawn_tailer(state, Duration::from_millis(150), move |r| {
            let _ = tx.send(r);
        })
        .expect("watch");

        fs::write(&path, format!("{USAGE_RECORD_LINE}\n{USAGE_RECORD_LINE}\n{USAGE_RECORD_LINE}\n")).unwrap();
        let offsets: Vec<u64> = (0..3)
            .map(|_| {
                let report = rx.recv_timeout(Duration::from_secs(10)).expect("a call");
                assert_eq!(report.payload["event"]["lane"], "calls");
                report.payload["sourceRef"]["offset"].as_u64().expect("its place")
            })
            .collect();
        let line = USAGE_RECORD_LINE.len() as u64 + 1;
        assert_eq!(offsets, vec![0, line, 2 * line]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tailer_delivers_appends_end_to_end_even_for_a_late_file() {
        let dir = temp_dir();
        let path = dir.join("rollout-live.jsonl");
        let state = Arc::new(Mutex::new(tail(path.clone())));
        let (tx, rx) = mpsc::channel::<Report>();

        // Armed BEFORE the file exists — the dir watch catches its creation.
        let _watcher = spawn_tailer(state, Duration::from_millis(150), move |r| {
            let _ = tx.send(r);
        })
        .expect("watch");

        fs::write(&path, format!("{TOKEN_COUNT_LINE}\n")).unwrap();
        let first = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("a usage report within 10s");
        assert_eq!(first.payload["event"]["record"]["type"], "event_msg");

        // A sibling session's rollout in the same day-dir must NOT leak in.
        fs::write(
            dir.join("rollout-other.jsonl"),
            format!("{TURN_CONTEXT_LINE}\n"),
        )
        .unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{TURN_CONTEXT_LINE}").unwrap();
        drop(file);
        let second = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the appended event within 10s");
        assert_eq!(second.payload["event"]["record"]["type"], "turn_context");

        fs::remove_dir_all(&dir).ok();
    }
}
