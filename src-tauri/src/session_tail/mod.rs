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

mod dialects;
mod reader;
mod rollouts;
mod route;
mod totals;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use crate::bridge::{Report, AGENT_STATUS_EVENT, USAGE_REPORT_EVENT};
use crate::fswatch;

use dialects::{claude_subagent_paths, last_of_each, TailedEvent};
use reader::{drain_file, TailCursor};
use route::{route, wrap, Routed};
use totals::{accumulate_session_totals, SessionTotals};

pub use dialects::TailFormat;
pub use rollouts::LatestRollout;

/// One followed session: where every source file is up to and how to
/// attribute what it yields. Claude owns a root transcript plus lazily
/// appearing `<session>/subagents/*.jsonl`; the other formats use only root.
/// The token is the pane's spawn-plan secret, passed by the webview at watch
/// time so tailer reports ride the reporter envelope's verification path.
struct TailState {
    path: PathBuf,
    pane_id: String,
    token: String,
    format: TailFormat,
    root: TailCursor,
    subagents: HashMap<PathBuf, TailCursor>,
    /// Running token cumulatives for formats whose files expose per-request
    /// rows rather than a native session total.
    totals: SessionTotals,
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
}

impl Drop for TailPoller {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Drain the root file and any subagent transcripts. The bool reports a
/// ROOT rotation: the whole file was re-read from offset 0, so this batch is
/// a REPLAY, not live appends — the deliverer must treat it as catch-up, or
/// every historical interrupt marker in the file fires again as if fresh.
fn drain_all(state: &mut TailState) -> (Vec<TailedEvent>, bool) {
    let (mut events, rotated) = drain_file(&state.path, &mut state.root, state.format);
    if rotated {
        state.totals = SessionTotals::default();
    }
    if state.format != TailFormat::Claude {
        return (events, rotated);
    }
    let paths = claude_subagent_paths(&state.path);
    for path in paths {
        let cursor = state.subagents.entry(path.clone()).or_default();
        let (appended, _) = drain_file(&path, cursor, TailFormat::Claude);
        for mut event in appended {
            // A subagent's abort is its own, never the pane's.
            event.root = false;
            events.push(event);
        }
    }
    (events, rotated)
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
    thread::Builder::new()
        .name("keepdeck usage tail".to_string())
        .spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                thread::sleep(interval);
                if flag.load(Ordering::Relaxed) {
                    break;
                }
                let Ok(mut s) = state.lock() else { break };
                let format = s.format;
                let (events, rotated) = drain_all(&mut s);
                for mut event in events {
                    // A subagent transcript's abort is the subagent's own
                    // story: pane-level status reads only ROOT markers.
                    if !event.root && event.payload["type"] == "session.interrupt" {
                        continue;
                    }
                    accumulate_session_totals(&mut s.totals, format, &mut event);
                    // A rotated tick re-read the WHOLE file: that is a
                    // replay wearing the poller's clothes, and it must say
                    // so — catch-up is what keeps a historical interrupt
                    // from firing as if it just happened.
                    deliver(wrap(&s.pane_id, &s.token, format.agent(), event, rotated));
                }
            }
        })
        .map_err(|e| format!("usage tail thread failed to start: {e}"))?;
    Ok(TailPoller { stop })
}

/// Follow one pane's session file, emitting its current usage state right
/// away. Idempotent per pane: a rebind (new session, new file) replaces the
/// old tail. `(async)` — the catch-up drain reads a whole session file.
#[tauri::command(async)]
pub fn usage_watch_session_file(
    app: AppHandle,
    tails: State<UsageTails>,
    pane_id: String,
    path: String,
    token: String,
    format: TailFormat,
) -> Result<(), String> {
    // Replace-first: the OLD tail must be gone before the new watcher arms,
    // or a same-path rebind briefly runs two tails and duplicates events.
    tails.0.remove(&pane_id);

    let state = Arc::new(Mutex::new(TailState {
        path: PathBuf::from(&path),
        pane_id: pane_id.clone(),
        token,
        format,
        root: TailCursor::default(),
        subagents: HashMap::new(),
        totals: SessionTotals::default(),
    }));

    // Watcher FIRST, catch-up second: an append landing during the catch-up
    // drain fires an event that re-drains whatever the catch-up hasn't
    // consumed (the offset is shared) — nothing is lost in the gap. The
    // reverse order lost any append between drain and arm until the NEXT
    // fs event. Lines the watcher wins ride as live reports; the catch-up
    // summary is marked catchUp so a replay can never outrank them.
    let emitter = app.clone();
    let watcher = spawn_tailer(state.clone(), POLL_INTERVAL, move |payload| {
        match route(payload) {
            Routed::Drop => {}
            Routed::Status(status) => {
                log::debug!("usage tail: pane={} interrupt marker", status.pane_id);
                let _ = emitter.emit(AGENT_STATUS_EVENT, &status);
            }
            Routed::Usage(report) => {
                log::debug!(
                    "usage tail: pane={} live {} event",
                    report.pane_id,
                    report.payload["event"]["type"]
                );
                let _ = emitter.emit(USAGE_REPORT_EVENT, &report);
            }
        }
    })?;
    let caught_up = {
        let mut s = state.lock().expect("tail state poisoned");
        // Fold the WHOLE catch-up drain into the running cumulative in file
        // order BEFORE last_of_each collapses it — the surviving last
        // usage.record then carries the session total of everything before it.
        let (mut drained, _) = drain_all(&mut s);
        for event in &mut drained {
            accumulate_session_totals(&mut s.totals, format, event);
        }
        let events = last_of_each(drained, format.catch_up_order());
        let count = events.len();
        for event in events {
            let report = wrap(&s.pane_id, &s.token, format.agent(), event, true);
            let _ = app.emit(USAGE_REPORT_EVENT, &report);
        }
        count
    };
    // One line per arm — the difference between "tail broken" and "tail
    // never armed" cost a blind debugging session once.
    log::info!(
        "usage tail: pane={pane_id} format={format:?} file={:?} catch-up={caught_up}",
        PathBuf::from(&path).file_name().unwrap_or_default(),
    );
    tails.0.insert(pane_id, watcher);
    Ok(())
}

/// Stop following a pane's session file (pane closed / rebind cleanup).
/// Unknown panes are a no-op.
#[tauri::command]
pub fn usage_unwatch_session_file(tails: State<UsageTails>, pane_id: String) {
    tails.0.remove(&pane_id);
}

/// The boot catch-up command — see [`rollouts`]. Thin wrapper: tauri's
/// command macros must live where `generate_handler!` names them.
#[tauri::command(async)]
pub fn usage_latest_codex_rollout() -> Option<LatestRollout> {
    rollouts::latest_codex_rollout()
}

/// The TUI-resume fallback resolver command — see [`rollouts`].
#[tauri::command(async)]
pub fn usage_find_codex_rollout(session_id: String) -> Option<String> {
    rollouts::find_codex_rollout(&session_id)
}

#[cfg(test)]
mod tests {
    use super::dialects::*;
    use super::reader::*;
    use super::rollouts::*;
    use super::route::*;
    use super::totals::*;
    use super::*;

    /// Root-only drain, as the pre-split suite spelled it. Every fixture
    /// here either has no subagents dir or wants them too — `drain_all`
    /// answers both.
    fn drain(state: &mut TailState) -> Vec<TailedEvent> {
        drain_all(state).0
    }

    /// The pre-split wire wrapper, kept as a test-local shim so the suite's
    /// many call sites read as before; production goes through [`wrap`].
    fn report(state: &TailState, event: TailedEvent, catch_up: bool) -> Report {
        wrap(
            &state.pane_id,
            &state.token,
            state.format.agent(),
            event,
            catch_up,
        )
    }
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("keepdeck-rollout-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const SOURCE_ISO: &str = "2026-07-16T22:13:08.000Z";
    const TOKEN_COUNT_LINE: &str = r#"{"timestamp":"2026-07-16T22:13:08.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":100},"last_token_usage":{"total_tokens":40},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":75.0,"window_minutes":10080,"resets_at":1784834810},"secondary":null,"plan_type":"plus"}}}"#;
    const TURN_CONTEXT_LINE: &str = r#"{"timestamp":"2026-07-16T22:13:08.000Z","type":"turn_context","payload":{"model":"gpt-5.6-sol","effort":"xhigh","cwd":"/x"}}"#;
    const USAGE_RECORD_LINE: &str = r#"{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":1200,"output":300,"inputCacheRead":40000,"inputCacheCreation":900},"usageScope":"turn","time":1784800000000}"#;
    const LLM_REQUEST_LINE: &str = r#"{"type":"llm.request","model":"kimi-code/k3","maxTokens":1048576,"messages":[{"role":"user","content":"SECRET PROMPT"}]}"#;
    const CLAUDE_ASSISTANT_LINE: &str = r#"{"type":"assistant","message":{"id":"msg-1","model":"claude-opus-4-8","content":[{"type":"text","text":"SECRET ANSWER"}],"usage":{"input_tokens":12,"output_tokens":30,"cache_read_input_tokens":40000,"cache_creation_input_tokens":900}},"timestamp":"2026-07-16T22:13:08.000Z"}"#;

    fn tail(path: PathBuf) -> TailState {
        TailState {
            path,
            pane_id: "pane-1".into(),
            token: "tok".into(),
            format: TailFormat::Codex,
            root: TailCursor::default(),
            subagents: HashMap::new(),
            totals: SessionTotals::default(),
        }
    }

    #[test]
    fn rollout_event_forwards_usage_and_context_only() {
        let token = rollout_event(TOKEN_COUNT_LINE.as_bytes()).expect("token_count");
        assert_eq!(token.payload["type"], "token_count");
        assert_eq!(
            token.payload["rate_limits"]["primary"]["used_percent"],
            75.0
        );
        assert_eq!(
            token.source_at,
            Some(SourceTimestamp::Iso(SOURCE_ISO.into()))
        );

        let turn = rollout_event(TURN_CONTEXT_LINE.as_bytes()).expect("turn_context");
        assert_eq!(turn.payload["type"], "turn_context");
        assert_eq!(turn.payload["model"], "gpt-5.6-sol");

        // Other event kinds, other line types and garbage are all skipped.
        assert_eq!(
            rollout_event(br#"{"type":"event_msg","payload":{"type":"agent_message"}}"#),
            None
        );
        assert_eq!(rollout_event(br#"{"type":"session_meta"}"#), None);
        assert_eq!(rollout_event(b"not json"), None);
    }

    #[test]
    fn claude_event_forwards_only_message_identity_and_token_buckets() {
        let event = claude_event(CLAUDE_ASSISTANT_LINE.as_bytes()).expect("assistant usage");
        assert_eq!(
            event.payload,
            serde_json::json!({
                "type": "assistant.usage",
                "messageId": "msg-1",
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 30,
                    "cache_read_input_tokens": 40000,
                    "cache_creation_input_tokens": 900,
                }
            })
        );
        assert_eq!(
            event.source_at,
            Some(SourceTimestamp::Iso(SOURCE_ISO.into()))
        );
        assert!(
            !event.payload.to_string().contains("SECRET"),
            "transcript content must never ride the event bus"
        );

        assert_eq!(claude_event(br#"{"type":"user","message":{}}"#), None);
        assert_eq!(
            claude_event(
                br#"{"type":"assistant","message":{"id":"x","model":"<synthetic>","usage":{"output_tokens":2}}}"#
            ),
            None
        );
        assert_eq!(
            claude_event(br#"{"type":"assistant","message":{"id":"x","usage":{}}}"#),
            None
        );
        assert_eq!(claude_event(b"not json"), None);
    }

    // The interrupt markers ride on the record's STRUCTURE, never its prose:
    // claude's dedicated `interruptedMessageId` field, codex's `turn_aborted`
    // record type — an assistant merely quoting the phrase trips neither.
    #[test]
    fn interrupt_markers_become_session_interrupt_events() {
        let claude_marker = format!(
            r#"{{"type":"user","interruptedMessageId":"msg-7","timestamp":"{SOURCE_ISO}","message":{{"role":"user","content":[{{"type":"text","text":"[Request interrupted by user]"}}]}}}}"#
        );
        let event = claude_event(claude_marker.as_bytes()).expect("interrupt");
        assert_eq!(
            event.payload,
            serde_json::json!({ "type": "session.interrupt", "reason": "interrupted" })
        );
        assert_eq!(
            event.source_at,
            Some(SourceTimestamp::Iso(SOURCE_ISO.into()))
        );
        // An ordinary user record — even one QUOTING the marker text — is
        // not an interrupt.
        assert_eq!(
            claude_event(
                br#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#
            ),
            None
        );
        assert_eq!(
            claude_event(br#"{"type":"user","interruptedMessageId":""}"#),
            None
        );

        let codex_marker = format!(
            r#"{{"timestamp":"{SOURCE_ISO}","type":"event_msg","payload":{{"type":"turn_aborted","turn_id":"t-1","reason":"interrupted"}}}}"#
        );
        let event = rollout_event(codex_marker.as_bytes()).expect("interrupt");
        assert_eq!(
            event.payload,
            serde_json::json!({ "type": "session.interrupt", "reason": "interrupted" })
        );
        // Non-user aborts keep their reason — the turn ended, but nobody
        // pressed Esc, and the label must be able to say so.
        let budget_marker = r#"{"type":"event_msg","payload":{"type":"turn_aborted","reason":"budget_exceeded"}}"#;
        let event = rollout_event(budget_marker.as_bytes()).expect("abort");
        assert_eq!(event.payload["reason"], "budget_exceeded");
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

        let mut state = tail(path);
        state.format = TailFormat::Claude;
        let (drained, _) = drain_all(&mut state);
        let interrupt = drained
            .iter()
            .find(|event| event.payload["type"] == "session.interrupt")
            .expect("subagent marker drained");
        assert!(!interrupt.root, "a subagent marker must not read as root");
        assert!(
            drained
                .iter()
                .filter(|event| event.payload["type"] != "session.interrupt")
                .all(|event| event.root),
            "root events keep their root tag"
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
        state.format = TailFormat::Claude;
        let (_, rotated) = drain_all(&mut state);
        assert!(!rotated, "first drain is a plain read");

        // Replace the file with SHORTER content — len < offset.
        fs::write(&path, "{}\n").unwrap();
        let (_, rotated) = drain_all(&mut state);
        assert!(rotated, "a shrunken file is a rotation, not appends");
        fs::remove_dir_all(&dir).ok();
    }

    // An old abort in the file must never relabel a fresh resume: the
    // catch-up summary keeps only the declared usage kinds.
    #[test]
    fn catch_up_never_replays_an_interrupt() {
        let interrupt = TailedEvent {
            payload: serde_json::json!({ "type": "session.interrupt" }),
            source_at: None,
            source_mtime_ms: None,
            root: true,
        };
        let kept = last_of_each(
            vec![interrupt],
            TailFormat::Claude.catch_up_order(),
        );
        assert!(kept.is_empty());
    }

    #[test]
    fn drain_reads_incrementally_and_carries_torn_lines() {
        let dir = temp_dir();
        let path = dir.join("rollout.jsonl");
        let mut state = tail(path.clone());

        // Nothing yet — the file doesn't even exist.
        assert!(drain(&mut state).is_empty());

        // A torn write: half a line, no newline — nothing to parse, carried.
        let (head, rest) = TOKEN_COUNT_LINE.split_at(50);
        fs::write(&path, head).unwrap();
        assert!(drain(&mut state).is_empty());

        // The rest lands (plus a full second line): both parse now.
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{rest}\n{TURN_CONTEXT_LINE}\n").unwrap();
        drop(file);
        let events = drain(&mut state);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].payload["type"], "token_count");
        assert_eq!(events[1].payload["type"], "turn_context");

        // Already consumed — nothing new.
        assert!(drain(&mut state).is_empty());

        // A shrunk file (rotation) restarts from zero instead of misreading.
        fs::write(&path, format!("{TURN_CONTEXT_LINE}\n")).unwrap();
        let events = drain(&mut state);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["type"], "turn_context");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wire_event_forwards_usage_and_trims_prompt_content() {
        let record = wire_event(USAGE_RECORD_LINE.as_bytes()).expect("usage.record");
        assert_eq!(record.payload["type"], "usage.record");
        assert_eq!(record.payload["usage"]["inputCacheRead"], 40000);
        assert_eq!(
            record.source_at,
            Some(SourceTimestamp::UnixMillis(1_784_800_000_000))
        );

        // llm.request keeps ONLY the scalars — the prompt must not ride the
        // event bus.
        let request = wire_event(LLM_REQUEST_LINE.as_bytes()).expect("llm.request");
        assert_eq!(
            request.payload,
            serde_json::json!({
                "type": "llm.request", "model": "kimi-code/k3", "maxTokens": 1048576,
            })
        );

        assert_eq!(wire_event(br#"{"type":"turn.prompt","text":"hi"}"#), None);
        assert_eq!(wire_event(b"not json"), None);
    }

    #[test]
    fn kimi_session_totals_sum_each_bucket_separately() {
        let mut totals = SessionTotals::default();
        // USAGE_RECORD_LINE: inputOther 1200, output 300, inputCacheRead 40000,
        // inputCacheCreation 900.
        let mut first = wire_event(USAGE_RECORD_LINE.as_bytes()).unwrap();
        accumulate_session_totals(&mut totals, TailFormat::KimiWire, &mut first);
        assert_eq!(
            first.payload["sessionTotals"],
            serde_json::json!({
                "inputOther": 1200, "output": 300,
                "inputCacheRead": 40000, "inputCacheCreation": 900
            })
        );

        let line2 = r#"{"type":"usage.record","usage":{"inputOther":800,"output":50,"inputCacheRead":41000,"inputCacheCreation":0},"usageScope":"turn","time":1784800001000}"#;
        let mut second = wire_event(line2.as_bytes()).unwrap();
        accumulate_session_totals(&mut totals, TailFormat::KimiWire, &mut second);
        // Fresh input (inputOther) and the re-read prefix (inputCacheRead) sum
        // in SEPARATE buckets — the prefix never inflates fresh input.
        assert_eq!(
            second.payload["sessionTotals"],
            serde_json::json!({
                "inputOther": 2000, "output": 350,
                "inputCacheRead": 81000, "inputCacheCreation": 900
            })
        );
        assert_eq!(
            totals.kimi,
            KimiTotals {
                input_other: 2000,
                output: 350,
                input_cache_read: 81000,
                input_cache_creation: 900,
            }
        );
    }

    #[test]
    fn accumulate_leaves_codex_and_non_usage_events_alone() {
        let mut totals = SessionTotals::default();
        // Codex owns a native cumulative — never stamped, even for a
        // usage.record-shaped line under the codex format.
        let mut codex = wire_event(USAGE_RECORD_LINE.as_bytes()).unwrap();
        accumulate_session_totals(&mut totals, TailFormat::Codex, &mut codex);
        assert!(codex.payload.get("sessionTotals").is_none());
        assert_eq!(totals, SessionTotals::default());
        // A kimi llm.request carries no counts — untouched.
        let mut request = wire_event(LLM_REQUEST_LINE.as_bytes()).unwrap();
        accumulate_session_totals(&mut totals, TailFormat::KimiWire, &mut request);
        assert!(request.payload.get("sessionTotals").is_none());
        assert_eq!(totals, SessionTotals::default());
    }

    #[test]
    fn claude_session_totals_deduplicate_repeated_message_rows() {
        let mut totals = SessionTotals::default();
        let mut first = claude_event(CLAUDE_ASSISTANT_LINE.as_bytes()).unwrap();
        accumulate_session_totals(&mut totals, TailFormat::Claude, &mut first);
        assert_eq!(
            first.payload["sessionTotals"],
            serde_json::json!({
                "input_tokens": 12,
                "output_tokens": 30,
                "cache_read_input_tokens": 40000,
                "cache_creation_input_tokens": 900,
            })
        );

        // Same id: each bucket advances only to its maximum, never sums the
        // repeated transcript row.
        let repeated = CLAUDE_ASSISTANT_LINE
            .replace(r#""output_tokens":30"#, r#""output_tokens":45"#)
            .replace(
                r#""cache_creation_input_tokens":900"#,
                r#""cache_creation_input_tokens":800"#,
            );
        let mut second = claude_event(repeated.as_bytes()).unwrap();
        accumulate_session_totals(&mut totals, TailFormat::Claude, &mut second);
        assert_eq!(
            second.payload["sessionTotals"],
            serde_json::json!({
                "input_tokens": 12,
                "output_tokens": 45,
                "cache_read_input_tokens": 40000,
                "cache_creation_input_tokens": 900,
            })
        );

        // A different assistant message contributes its own maxima.
        let next_message = CLAUDE_ASSISTANT_LINE
            .replace("msg-1", "msg-2")
            .replace(r#""input_tokens":12"#, r#""input_tokens":2"#)
            .replace(r#""output_tokens":30"#, r#""output_tokens":5"#)
            .replace(
                r#""cache_read_input_tokens":40000"#,
                r#""cache_read_input_tokens":100"#,
            )
            .replace(
                r#""cache_creation_input_tokens":900"#,
                r#""cache_creation_input_tokens":3"#,
            );
        let mut third = claude_event(next_message.as_bytes()).unwrap();
        accumulate_session_totals(&mut totals, TailFormat::Claude, &mut third);
        assert_eq!(
            third.payload["sessionTotals"],
            serde_json::json!({
                "input_tokens": 14,
                "output_tokens": 50,
                "cache_read_input_tokens": 40100,
                "cache_creation_input_tokens": 903,
            })
        );
        assert_eq!(totals.claude.by_message.len(), 2);
    }

    #[test]
    fn drain_rotation_resets_the_kimi_cumulative() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let mut state = tail(path.clone());
        state.format = TailFormat::KimiWire;

        fs::write(&path, format!("{USAGE_RECORD_LINE}\n{USAGE_RECORD_LINE}\n")).unwrap();
        for mut event in drain(&mut state) {
            accumulate_session_totals(&mut state.totals, TailFormat::KimiWire, &mut event);
        }
        assert_eq!(state.totals.kimi.input_other, 2400);

        // A shrunk file (rotation / new session): drain zeroes the cumulative
        // so the new session sums from scratch, not atop the old one.
        fs::write(&path, format!("{USAGE_RECORD_LINE}\n")).unwrap();
        let events = drain(&mut state);
        assert_eq!(state.totals, SessionTotals::default());
        for mut event in events {
            accumulate_session_totals(&mut state.totals, TailFormat::KimiWire, &mut event);
        }
        assert_eq!(state.totals.kimi.input_other, 1200);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn catch_up_last_record_carries_the_full_session_cumulative() {
        // The crux invariant, end to end: fold the whole drain in file order,
        // THEN last_of_each keeps the last usage.record — which must carry the
        // cumulative of ALL prior records, not just its own line (mirrors the
        // order in usage_watch_session_file). A refactor that ran last_of_each
        // first would silently drop the earlier records' tokens.
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let mut state = tail(path.clone());
        state.format = TailFormat::KimiWire;
        let record = |input: u64| {
            format!(
                r#"{{"type":"usage.record","usage":{{"inputOther":{input},"output":10,"inputCacheRead":0,"inputCacheCreation":0}},"usageScope":"turn","time":1}}"#
            )
        };
        fs::write(
            &path,
            format!("{}\n{}\n{}\n", record(100), record(200), record(300)),
        )
        .unwrap();

        let mut drained = drain(&mut state);
        for event in &mut drained {
            accumulate_session_totals(&mut state.totals, TailFormat::KimiWire, event);
        }
        let kept = last_of_each(drained, TailFormat::KimiWire.catch_up_order());
        let surviving = kept
            .iter()
            .find(|e| e.payload["type"] == "usage.record")
            .expect("a usage.record survives catch-up");
        assert_eq!(surviving.payload["sessionTotals"]["inputOther"], 600); // 100+200+300
        assert_eq!(surviving.payload["sessionTotals"]["output"], 30);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claude_catch_up_keeps_the_full_deduplicated_session_cumulative() {
        let dir = temp_dir();
        let path = dir.join("claude.jsonl");
        let mut state = tail(path.clone());
        state.format = TailFormat::Claude;
        let repeated =
            CLAUDE_ASSISTANT_LINE.replace(r#""output_tokens":30"#, r#""output_tokens":45"#);
        let next = CLAUDE_ASSISTANT_LINE
            .replace("msg-1", "msg-2")
            .replace(r#""output_tokens":30"#, r#""output_tokens":5"#);
        fs::write(
            &path,
            format!("{CLAUDE_ASSISTANT_LINE}\n{repeated}\n{next}\n"),
        )
        .unwrap();

        let mut drained = drain(&mut state);
        for event in &mut drained {
            accumulate_session_totals(&mut state.totals, TailFormat::Claude, event);
        }
        let kept = last_of_each(drained, TailFormat::Claude.catch_up_order());
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].payload["type"], "assistant.usage");
        assert_eq!(kept[0].payload["sessionTotals"]["output_tokens"], 50);
        assert_eq!(
            kept[0].payload["sessionTotals"]["cache_read_input_tokens"],
            80000
        );

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

        let mut state = tail(path);
        state.format = TailFormat::Claude;
        let (mut drained, _) = drain_all(&mut state);
        assert_eq!(drained.len(), 2);
        assert!(
            drained
                .iter()
                .all(|event| !event.payload.to_string().contains("SECRET")),
            "root and subagent transcript content must stay private"
        );
        for event in &mut drained {
            accumulate_session_totals(&mut state.totals, TailFormat::Claude, event);
        }
        let kept = last_of_each(drained, TailFormat::Claude.catch_up_order());
        assert_eq!(kept[0].payload["sessionTotals"]["input_tokens"], 14);
        assert_eq!(kept[0].payload["sessionTotals"]["output_tokens"], 37);
        assert_eq!(
            kept[0].payload["sessionTotals"]["cache_read_input_tokens"],
            40100
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claude_discovers_a_subagent_file_created_after_arming() {
        let dir = temp_dir();
        let path = dir.join("session-late.jsonl");
        fs::write(&path, format!("{CLAUDE_ASSISTANT_LINE}\n")).unwrap();
        let mut state = tail(path);
        state.format = TailFormat::Claude;
        for mut event in drain_all(&mut state).0 {
            accumulate_session_totals(&mut state.totals, TailFormat::Claude, &mut event);
        }

        let subagents = dir.join("session-late/subagents");
        fs::create_dir_all(&subagents).unwrap();
        let subagent = CLAUDE_ASSISTANT_LINE
            .replace("msg-1", "msg-late")
            .replace(r#""output_tokens":30"#, r#""output_tokens":5"#);
        fs::write(subagents.join("agent-late.jsonl"), format!("{subagent}\n")).unwrap();

        let (mut appended, _) = drain_all(&mut state);
        assert_eq!(appended.len(), 1);
        accumulate_session_totals(&mut state.totals, TailFormat::Claude, &mut appended[0]);
        assert_eq!(appended[0].payload["sessionTotals"]["output_tokens"], 35);
        assert!(drain_all(&mut state).0.is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn catch_up_keeps_only_the_last_of_each_kind_context_first() {
        let old = rollout_event(TURN_CONTEXT_LINE.as_bytes()).unwrap();
        let mut newer = old.clone();
        newer.payload["model"] = "gpt-6".into();
        let count = rollout_event(TOKEN_COUNT_LINE.as_bytes()).unwrap();

        let order = TailFormat::Codex.catch_up_order();
        let kept = last_of_each(vec![old, count.clone(), newer.clone()], order);
        assert_eq!(kept, vec![newer, count]);
        assert!(last_of_each(Vec::new(), order).is_empty());

        // The kimi order: window/model (llm.request) before the numbers.
        let request = wire_event(LLM_REQUEST_LINE.as_bytes()).unwrap();
        let record = wire_event(USAGE_RECORD_LINE.as_bytes()).unwrap();
        let kept = last_of_each(
            vec![record.clone(), request.clone()],
            TailFormat::KimiWire.catch_up_order(),
        );
        assert_eq!(kept, vec![request, record]);
    }

    #[test]
    fn reports_carry_the_agent_tag_and_the_catch_up_mark() {
        let mut state = tail(PathBuf::from("/x/rollout.jsonl"));
        let mut event = rollout_event(TURN_CONTEXT_LINE.as_bytes()).unwrap();
        event.source_mtime_ms = Some(1_234);
        let wrapped = report(&state, event, false);
        assert_eq!(wrapped.pane_id, "pane-1");
        assert_eq!(wrapped.token, "tok");
        assert_eq!(wrapped.payload["agent"], "codex");
        assert_eq!(wrapped.payload["event"]["type"], "turn_context");
        assert_eq!(wrapped.payload["catchUp"], false);
        assert_eq!(wrapped.payload["sourceAt"], SOURCE_ISO);
        assert_eq!(wrapped.payload["sourceMtimeMs"], 1_234);

        state.format = TailFormat::KimiWire;
        let event = wire_event(USAGE_RECORD_LINE.as_bytes()).unwrap();
        let wrapped = report(&state, event, true);
        assert_eq!(wrapped.payload["agent"], "kimi");
        assert_eq!(wrapped.payload["catchUp"], true);
        assert_eq!(wrapped.payload["sourceAt"], 1_784_800_000_000_u64);

        state.format = TailFormat::Claude;
        let event = claude_event(CLAUDE_ASSISTANT_LINE.as_bytes()).unwrap();
        let wrapped = report(&state, event, true);
        assert_eq!(wrapped.payload["agent"], "claude");
        assert_eq!(wrapped.payload["event"]["type"], "assistant.usage");
    }

    #[test]
    fn an_oversized_line_is_abandoned_and_the_tail_resyncs() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let mut state = tail(path.clone());

        // A monster line spilling past the cap, no newline yet.
        fs::write(&path, vec![b'x'; MAX_PARTIAL_BYTES + 64]).unwrap();
        assert!(drain(&mut state).is_empty());
        assert!(state.root.skipping, "the line is abandoned, not buffered");
        assert!(state.root.partial.is_empty());

        // Its newline finally lands, followed by a healthy line — the tail
        // resyncs and parses only the healthy one.
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "tail-of-monster\n{TURN_CONTEXT_LINE}\n").unwrap();
        drop(file);
        let events = drain(&mut state);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["type"], "turn_context");
        assert!(!state.root.skipping);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_rotation_while_skipping_keeps_the_new_files_first_line() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let mut state = tail(path.clone());

        // Monster line puts the tail into skip mode…
        fs::write(&path, vec![b'x'; MAX_PARTIAL_BYTES + 64]).unwrap();
        assert!(drain(&mut state).is_empty());
        assert!(state.root.skipping);

        // …then the file is ROTATED before the monster's newline arrives.
        // The fresh file's first line must parse, not vanish as the
        // monster's imagined tail.
        fs::write(&path, format!("{TURN_CONTEXT_LINE}\n")).unwrap();
        let events = drain(&mut state);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["type"], "turn_context");
        assert!(!state.root.skipping);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn find_rollout_walks_the_day_tree_and_prefers_the_newest_match() {
        let root = temp_dir();
        let sid = "019f7683-d6f4-7b00-8e66-00c4694731be";
        let old_day = root.join("2026/07/17");
        let new_day = root.join("2026/07/18");
        fs::create_dir_all(&old_day).unwrap();
        fs::create_dir_all(&new_day).unwrap();
        fs::write(
            old_day.join(format!("rollout-2026-07-17T01-00-00-{sid}.jsonl")),
            "x",
        )
        .unwrap();
        fs::write(new_day.join("rollout-2026-07-18T02-00-00-other.jsonl"), "x").unwrap();
        let newest = new_day.join(format!("rollout-2026-07-18T03-00-00-{sid}.jsonl"));
        fs::write(&newest, "x").unwrap();

        assert_eq!(find_rollout_in(&root, sid), Some(newest));
        assert_eq!(find_rollout_in(&root, "0000-none"), None);
        fs::remove_dir_all(&root).ok();
    }

    /// Pin a file's mtime so newest-first ordering is deterministic even
    /// when the test writes everything within one clock tick.
    fn set_mtime(path: &std::path::Path, secs_after_epoch: u64) {
        OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(secs_after_epoch))
            .unwrap();
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
    fn boot_sweep_returns_the_newest_rollout_that_carries_usage() {
        let root = temp_dir();
        let day = root.join("2026/07/19");
        fs::create_dir_all(&day).unwrap();

        // Oldest: real usage. Newer: usage with a distinct marker. Newest:
        // a fresh session with no token_count yet — must be walked past.
        let oldest = day.join("rollout-2026-07-19T01-00-00-aaaa.jsonl");
        fs::write(&oldest, format!("{TOKEN_COUNT_LINE}\n")).unwrap();
        set_mtime(&oldest, 1_000);
        let with_usage = day.join("rollout-2026-07-19T02-00-00-bbbb.jsonl");
        let marked = TOKEN_COUNT_LINE.replace("75.0", "33.0");
        fs::write(&with_usage, format!("{TURN_CONTEXT_LINE}\n{marked}\n")).unwrap();
        set_mtime(&with_usage, 2_000);
        let empty_of_usage = day.join("rollout-2026-07-19T03-00-00-cccc.jsonl");
        fs::write(&empty_of_usage, format!("{TURN_CONTEXT_LINE}\n")).unwrap();
        set_mtime(&empty_of_usage, 3_000);

        let found = latest_rollout_usage_in(&root).expect("usage found");
        assert_eq!(found.event["type"], "token_count");
        assert_eq!(found.event["rate_limits"]["primary"]["used_percent"], 33.0);
        assert_eq!(
            found.source_at,
            Some(SourceTimestamp::Iso(SOURCE_ISO.into()))
        );
        assert_eq!(found.mtime_ms, 2_000_000, "stamped with the FILE's age");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn boot_sweep_finds_nothing_in_an_empty_or_usage_free_tree() {
        let root = temp_dir();
        assert_eq!(latest_rollout_usage_in(&root), None);

        let day = root.join("2026/07/19");
        fs::create_dir_all(&day).unwrap();
        fs::write(
            day.join("rollout-2026-07-19T01-00-00-aaaa.jsonl"),
            format!("{TURN_CONTEXT_LINE}\n"),
        )
        .unwrap();
        // Non-rollout siblings never count as sessions.
        fs::write(day.join("notes.jsonl"), format!("{TOKEN_COUNT_LINE}\n")).unwrap();
        assert_eq!(latest_rollout_usage_in(&root), None);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn kimi_wire_drains_through_the_same_incremental_reader() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let mut state = tail(path.clone());
        state.format = TailFormat::KimiWire;

        fs::write(&path, format!("{LLM_REQUEST_LINE}\n{USAGE_RECORD_LINE}\n")).unwrap();
        let events = drain(&mut state);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].payload["type"], "llm.request");
        assert_eq!(events[1].payload["type"], "usage.record");

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
        assert_eq!(first.payload["event"]["type"], "token_count");

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
        assert_eq!(second.payload["event"]["type"], "turn_context");

        fs::remove_dir_all(&dir).ok();
    }
}
