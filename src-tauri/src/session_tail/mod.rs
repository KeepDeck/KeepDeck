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
#[cfg(test)]
mod test_support;
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

use dialects::{claude_subagent_paths, last_of_each, TailWatch, TailedEvent};
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
    /// What this pane's agent asked to have carried out of its store, when
    /// its plugin declared a dialect. Absent for an agent that has not moved
    /// over: then only the format's own arms run, exactly as before.
    watch: Option<TailWatch>,
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

/// Drain the root file and any subagent transcripts. The flags report
/// replays PER LANE: `root` = the root file re-read from offset 0, `any` =
/// some followed file did — so the deliverer can mark each event by ITS
/// OWN file's fate. One batch-wide flag was tried and reverted: it stamped
/// a fresh root interrupt catch-up whenever a subagent happened to rotate
/// in the same tick, and the tail lane is claude's ONLY interrupt source —
/// the Esc was simply lost (review finding).
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
    let (mut events, root_rotated) =
        drain_file(&state.path, &mut state.root, state.format, state.watch.as_ref());
    if root_rotated {
        state.totals = SessionTotals::default();
    }
    if state.format != TailFormat::Claude {
        return (
            events,
            DrainReplay {
                root: root_rotated,
                any: root_rotated,
            },
        );
    }
    let mut any = root_rotated;
    let paths = claude_subagent_paths(&state.path);
    for path in paths {
        let cursor = state.subagents.entry(path.clone()).or_default();
        if root_rotated {
            *cursor = TailCursor::default();
        }
        let (appended, sub_rotated) =
            drain_file(&path, cursor, TailFormat::Claude, state.watch.as_ref());
        any = any || sub_rotated;
        for mut event in appended {
            // A subagent's abort is its own, never the pane's.
            event.root = false;
            events.push(event);
        }
    }
    (
        events,
        DrainReplay {
            root: root_rotated,
            any,
        },
    )
}

/// One door out of the tailer: every report — live poll or arm-time
/// catch-up — routes identically, so a replayed interrupt can never reach
/// the status lane through a second, unrouted path.
fn deliver_routed(app: &AppHandle, report: Report) {
    match route(report) {
        Routed::Drop => {}
        Routed::Status(status) => {
            log::debug!("usage tail: pane={} interrupt marker", status.pane_id);
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
                let (events, replay) = drain_all(&mut s);
                for mut event in events {
                    // A subagent transcript's abort is the subagent's own
                    // story: pane-level status reads only ROOT markers.
                    if !event.root && event.payload["type"] == "session.interrupt" {
                        continue;
                    }
                    accumulate_session_totals(&mut s.totals, format, &mut event);
                    // A rotated file was re-read WHOLE: those events are a
                    // replay wearing the poller's clothes, and must say so
                    // — catch-up is what keeps a historical interrupt from
                    // firing as if it just happened. Marked by the event's
                    // OWN file, so a subagent's rotation can never cost a
                    // fresh root Esc its delivery.
                    let catch_up = if event.root { replay.root } else { replay.any };
                    deliver(wrap(&s.pane_id, &s.token, format.agent(), event, catch_up));
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
    watch: Option<TailWatch>,
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
        watch,
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
        deliver_routed(&emitter, payload);
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
            // Through the SAME router as the live path — catch-up safety
            // must not rest on `catch_up_order()` happening to list no
            // interrupt kinds; the router's replayed-interrupt Drop rule
            // holds here by construction.
            deliver_routed(&app, report);
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

// The TUI-resume fallback resolver used to be a command here. It named an
// agent in the host's own command surface and knew where that agent keeps
// its files; both are the agent's business, and its plugin was already
// walking the same tree for its history browser. The dialect answers now.

#[cfg(test)]
mod tests {
    use super::dialects::*;
    
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
    use std::sync::mpsc;
    use std::time::Duration;

    use super::test_support::*;

    fn tail(path: PathBuf) -> TailState {
        TailState {
            path,
            pane_id: "pane-1".into(),
            token: "tok".into(),
            format: TailFormat::Codex,
            root: TailCursor::default(),
            watch: None,
            subagents: HashMap::new(),
            totals: SessionTotals::default(),
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

        let mut state = tail(path);
        state.format = TailFormat::Claude;
        // The marker reaches this side only because the pane's dialect asked
        // for it. Without a watch there is nothing to tag, which is itself
        // the state of a tail whose plugin has not moved over.
        state.watch = Some(dialects::TailWatch {
            clauses: vec![dialects::RecordMatch {
                key: "interruptedMessageId".into(),
                equals: None,
            }],
            keep: vec!["interruptedMessageId".into()],
        });
        let (drained, _) = drain_all(&mut state);
        let carried = drained
            .iter()
            .find(|event| event.payload["type"] == dialects::CARRIED_RECORD)
            .expect("subagent marker drained");
        assert!(!carried.root, "a subagent marker must not read as root");
        assert!(
            drained
                .iter()
                .filter(|event| event.payload["type"] != dialects::CARRIED_RECORD)
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

        let mut state = tail(path.clone());
        state.format = TailFormat::Claude;
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
        fs::write(&sub, format!("{CLAUDE_ASSISTANT_LINE}\n{CLAUDE_ASSISTANT_LINE}\n")).unwrap();

        let mut state = tail(path.clone());
        state.format = TailFormat::Claude;
        drain_all(&mut state);

        // Only the SUBAGENT file shrinks; the root is untouched.
        fs::write(&sub, format!("{CLAUDE_ASSISTANT_LINE}\n")).unwrap();
        let (events, replay) = drain_all(&mut state);
        assert!(replay.any, "the subagent's replay must be marked");
        assert!(!replay.root, "the root lane stays live — its Esc must land");
        assert!(events.iter().all(|event| !event.root));
        fs::remove_dir_all(&dir).ok();
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
