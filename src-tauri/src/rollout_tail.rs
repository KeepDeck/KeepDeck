//! Usage tailer — per-pane session-file followers (codex rollouts, kimi
//! wire logs).
//!
//! Codex embeds rate-limit and token data in its session rollout file (one
//! `token_count` event per turn, a `turn_context` per turn for the model);
//! kimi appends a `usage.record` per LLM request to its wire.jsonl (window
//! size rides the `llm.request` before it). No hook carries usage in either
//! CLI. The webview learns a pane's session file from the binding
//! (`transcriptPath`) and arms a tail here with the FORMAT its agent
//! speaks; every matching event is wrapped into the same [`UsageReport`]
//! the bridge emits for other agents — one wire shape, the TS normalizers
//! own the payload schema.
//!
//! Three deliberate choices:
//! - The file's PARENT directory is watched (non-recursively): the rollout
//!   may not exist yet at bind time, and a dir watch sees its creation for
//!   free. Events are filtered to the one file by name.
//! - Registration immediately drains the EXISTING file and emits only the
//!   LAST token_count and turn_context found — instant restore of limits
//!   and model after an app restart, without replaying a session's history.
//! - Reads are incremental (offset + carried partial line, both byte-wise —
//!   a torn multi-byte character or half-written line never breaks parsing;
//!   it completes on the next fs event).

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use notify::{Event, EventKind, RecommendedWatcher};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::bridge::{UsageReport, USAGE_REPORT_EVENT};
use crate::fswatch;

/// Which session-file dialect a tail parses. Chosen by the webview (it
/// knows the pane's agent); each format owns its line filter, its catch-up
/// order and the `agent` tag its payloads carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TailFormat {
    /// Codex rollout `.jsonl`: `token_count` + `turn_context`.
    Codex,
    /// Kimi wire `.jsonl`: `usage.record` + trimmed `llm.request`.
    KimiWire,
}

impl TailFormat {
    fn agent(self) -> &'static str {
        match self {
            TailFormat::Codex => "codex",
            TailFormat::KimiWire => "kimi",
        }
    }

    /// Catch-up kinds, context first so the model/window lands before the
    /// numbers it qualifies.
    fn catch_up_order(self) -> [&'static str; 2] {
        match self {
            TailFormat::Codex => ["turn_context", "token_count"],
            TailFormat::KimiWire => ["llm.request", "usage.record"],
        }
    }

    fn event(self, line: &[u8]) -> Option<Value> {
        match self {
            TailFormat::Codex => rollout_event(line),
            TailFormat::KimiWire => wire_event(line),
        }
    }
}

/// One followed session file: where we are in it and how to attribute what
/// we find. The token is the pane's spawn-plan secret, passed by the webview
/// at watch time so tailer reports ride the same verification path as
/// reporter envelopes.
struct TailState {
    path: PathBuf,
    pane_id: String,
    token: String,
    format: TailFormat,
    offset: u64,
    partial: Vec<u8>,
}

/// The watcher's closure owns the tail state (via its `Arc`); dropping the
/// watcher drops the tail.
struct TailHandle {
    _watcher: RecommendedWatcher,
}

/// The live rollout tails, keyed by pane id. Tauri managed state; replacing
/// or removing an entry drops its watcher.
#[derive(Default)]
pub struct UsageTails(Mutex<HashMap<String, TailHandle>>);

impl UsageTails {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, TailHandle>> {
        self.0.lock().expect("usage tails poisoned")
    }
}

/// One rollout line → the payload event worth forwarding, if any:
/// `token_count` (usage + rate limits) and `turn_context` (model). Anything
/// else — user messages, tool calls, garbage — is `None`.
fn rollout_event(line: &[u8]) -> Option<Value> {
    let value: Value = serde_json::from_slice(line).ok()?;
    match value.get("type")?.as_str()? {
        "event_msg" => {
            let payload = value.get("payload")?;
            if payload.get("type")?.as_str()? == "token_count" {
                Some(payload.clone())
            } else {
                None
            }
        }
        "turn_context" => {
            let mut payload = value.get("payload")?.as_object()?.clone();
            payload.insert("type".into(), "turn_context".into());
            Some(Value::Object(payload))
        }
        _ => None,
    }
}

/// One kimi wire line → the payload event worth forwarding. `usage.record`
/// is small and rides verbatim; `llm.request` is TRIMMED to the two scalars
/// the normalizer needs (model, maxTokens) — the full event carries prompt
/// content, which must never ride the app's event bus.
fn wire_event(line: &[u8]) -> Option<Value> {
    let value: Value = serde_json::from_slice(line).ok()?;
    match value.get("type")?.as_str()? {
        "usage.record" => Some(value),
        "llm.request" => {
            let mut trimmed = serde_json::Map::new();
            trimmed.insert("type".into(), "llm.request".into());
            for key in ["model", "maxTokens"] {
                if let Some(v) = value.get(key) {
                    trimmed.insert(key.into(), v.clone());
                }
            }
            Some(Value::Object(trimmed))
        }
        _ => None,
    }
}

/// Read everything appended since the recorded offset and return the events
/// of the COMPLETE new lines; a trailing partial line is carried for the
/// next call. A missing file is "nothing yet"; a shrunk file (rotation)
/// restarts from zero.
fn drain(state: &mut TailState) -> Vec<Value> {
    let Ok(mut file) = File::open(&state.path) else {
        return Vec::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len < state.offset {
        state.offset = 0;
        state.partial.clear();
    }
    if len == state.offset || file.seek(SeekFrom::Start(state.offset)).is_err() {
        return Vec::new();
    }
    let mut fresh = Vec::new();
    let Ok(read) = file.read_to_end(&mut fresh) else {
        return Vec::new();
    };
    state.offset += read as u64;
    state.partial.extend_from_slice(&fresh);

    let mut events = Vec::new();
    while let Some(nl) = state.partial.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = state.partial.drain(..=nl).collect();
        if let Some(event) = state.format.event(&line[..line.len() - 1]) {
            events.push(event);
        }
    }
    events
}

/// The catch-up summary: of everything drained from an existing file, only
/// the LAST of each kind matters, emitted in the format's declared order.
fn last_of_each(events: Vec<Value>, order: [&str; 2]) -> Vec<Value> {
    let mut last: [Option<Value>; 2] = [None, None];
    for event in events {
        let Some(kind) = event.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        if let Some(slot) = order.iter().position(|k| *k == kind) {
            last[slot] = Some(event);
        }
    }
    last.into_iter().flatten().collect()
}

/// Wrap one session-file event into the bridge's wire shape.
fn report(state: &TailState, event: Value) -> UsageReport {
    UsageReport {
        pane_id: state.pane_id.clone(),
        token: state.token.clone(),
        payload: json!({ "agent": state.format.agent(), "event": event }),
    }
}

/// Is this fs event about our rollout file? The watched day-directory holds
/// every session's rollout — filter by exact file name.
fn is_our_file(event: &Event, path: &PathBuf) -> bool {
    matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_))
        && event
            .paths
            .iter()
            .any(|p| p.file_name() == path.file_name())
}

/// Start the watcher for one tail. Delivery is a plain closure so the
/// pipeline is testable without a Tauri app handle.
fn spawn_tailer(
    state: Arc<Mutex<TailState>>,
    deliver: impl Fn(UsageReport) + Send + 'static,
) -> Result<RecommendedWatcher, String> {
    let (path, parent) = {
        let s = state.lock().expect("tail state poisoned");
        let parent = s
            .path
            .parent()
            .ok_or("rollout path has no parent directory")?
            .to_path_buf();
        (s.path.clone(), parent)
    };
    fswatch::watch_dir(&parent, move |event| {
        if !is_our_file(event, &path) {
            return;
        }
        let Ok(mut s) = state.lock() else { return };
        for event in drain(&mut s) {
            deliver(report(&s, event));
        }
    })
}

/// Follow one pane's session file, emitting its current usage state right
/// away. Idempotent per pane: a rebind (new session, new file) replaces the
/// old tail. `(async)` — the catch-up drain reads a whole session file.
#[tauri::command(async)]
pub fn usage_watch_rollout(
    app: AppHandle,
    tails: State<UsageTails>,
    pane_id: String,
    path: String,
    token: String,
    format: TailFormat,
) -> Result<(), String> {
    let state = Arc::new(Mutex::new(TailState {
        path: PathBuf::from(&path),
        pane_id: pane_id.clone(),
        token,
        format,
        offset: 0,
        partial: Vec::new(),
    }));

    // Catch up on the existing file first: the last known limits/model land
    // in the store before any live event — instant restore after a restart.
    {
        let mut s = state.lock().expect("tail state poisoned");
        for event in last_of_each(drain(&mut s), format.catch_up_order()) {
            let _ = app.emit(USAGE_REPORT_EVENT, &report(&s, event));
        }
    }

    let emitter = app.clone();
    let watcher = spawn_tailer(state, move |payload| {
        let _ = emitter.emit(USAGE_REPORT_EVENT, &payload);
    })?;
    tails.lock().insert(pane_id, TailHandle { _watcher: watcher });
    Ok(())
}

/// Stop following a pane's rollout (pane closed / rebind cleanup). Unknown
/// panes are a no-op.
#[tauri::command]
pub fn usage_unwatch_rollout(tails: State<UsageTails>, pane_id: String) {
    tails.lock().remove(&pane_id);
}

/// Locate a codex session's rollout by its recorded id — the fallback for
/// TUI resumes: codex (observed on 0.144.5) fires SessionStart in `exec`
/// and `exec resume` but NOT in the interactive `resume`, so no binding
/// carries the path. Rollout names end `-<session_id>.jsonl` under the
/// day-partitioned `~/.codex/sessions/YYYY/MM/DD/`; the newest match wins.
fn find_rollout_in(root: &std::path::Path, session_id: &str) -> Option<PathBuf> {
    let suffix = format!("-{session_id}.jsonl");
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    let days = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|y| std::fs::read_dir(y.path()).into_iter().flatten().flatten())
        .flat_map(|m| std::fs::read_dir(m.path()).into_iter().flatten().flatten());
    for day in days {
        let Ok(files) = std::fs::read_dir(day.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let matches = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(&suffix));
            if !matches {
                continue;
            }
            let modified = file
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if newest.as_ref().is_none_or(|(t, _)| modified > *t) {
                newest = Some((modified, path));
            }
        }
    }
    newest.map(|(_, path)| path)
}

/// The fallback resolver command. The id is sanitized to uuid characters —
/// it names a file suffix, nothing else may ride in.
#[tauri::command(async)]
pub fn usage_find_codex_rollout(session_id: String) -> Option<String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    let root = PathBuf::from(home).join(".codex/sessions");
    find_rollout_in(&root, &session_id).map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("keepdeck-rollout-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const TOKEN_COUNT_LINE: &str = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":100},"last_token_usage":{"total_tokens":40},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":75.0,"window_minutes":10080,"resets_at":1784834810},"secondary":null,"plan_type":"plus"}}}"#;
    const TURN_CONTEXT_LINE: &str =
        r#"{"timestamp":"t","type":"turn_context","payload":{"model":"gpt-5.6-sol","effort":"xhigh","cwd":"/x"}}"#;
    const USAGE_RECORD_LINE: &str = r#"{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":1200,"output":300,"inputCacheRead":40000,"inputCacheCreation":900},"usageScope":"turn","time":1784800000000}"#;
    const LLM_REQUEST_LINE: &str = r#"{"type":"llm.request","model":"kimi-code/k3","maxTokens":1048576,"messages":[{"role":"user","content":"SECRET PROMPT"}]}"#;

    fn tail(path: PathBuf) -> TailState {
        TailState {
            path,
            pane_id: "pane-1".into(),
            token: "tok".into(),
            format: TailFormat::Codex,
            offset: 0,
            partial: Vec::new(),
        }
    }

    #[test]
    fn rollout_event_forwards_usage_and_context_only() {
        let token = rollout_event(TOKEN_COUNT_LINE.as_bytes()).expect("token_count");
        assert_eq!(token["type"], "token_count");
        assert_eq!(token["rate_limits"]["primary"]["used_percent"], 75.0);

        let turn = rollout_event(TURN_CONTEXT_LINE.as_bytes()).expect("turn_context");
        assert_eq!(turn["type"], "turn_context");
        assert_eq!(turn["model"], "gpt-5.6-sol");

        // Other event kinds, other line types and garbage are all skipped.
        assert_eq!(
            rollout_event(br#"{"type":"event_msg","payload":{"type":"agent_message"}}"#),
            None
        );
        assert_eq!(rollout_event(br#"{"type":"session_meta"}"#), None);
        assert_eq!(rollout_event(b"not json"), None);
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
        assert_eq!(events[0]["type"], "token_count");
        assert_eq!(events[1]["type"], "turn_context");

        // Already consumed — nothing new.
        assert!(drain(&mut state).is_empty());

        // A shrunk file (rotation) restarts from zero instead of misreading.
        fs::write(&path, format!("{TURN_CONTEXT_LINE}\n")).unwrap();
        let events = drain(&mut state);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "turn_context");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wire_event_forwards_usage_and_trims_prompt_content() {
        let record = wire_event(USAGE_RECORD_LINE.as_bytes()).expect("usage.record");
        assert_eq!(record["type"], "usage.record");
        assert_eq!(record["usage"]["inputCacheRead"], 40000);

        // llm.request keeps ONLY the scalars — the prompt must not ride the
        // event bus.
        let request = wire_event(LLM_REQUEST_LINE.as_bytes()).expect("llm.request");
        assert_eq!(
            request,
            serde_json::json!({
                "type": "llm.request", "model": "kimi-code/k3", "maxTokens": 1048576,
            })
        );

        assert_eq!(wire_event(br#"{"type":"turn.prompt","text":"hi"}"#), None);
        assert_eq!(wire_event(b"not json"), None);
    }

    #[test]
    fn catch_up_keeps_only_the_last_of_each_kind_context_first() {
        let old = rollout_event(TURN_CONTEXT_LINE.as_bytes()).unwrap();
        let mut newer = old.clone();
        newer["model"] = "gpt-6".into();
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
    fn reports_carry_the_format_agent_tag() {
        let mut state = tail(PathBuf::from("/x/rollout.jsonl"));
        let event = rollout_event(TURN_CONTEXT_LINE.as_bytes()).unwrap();
        let wrapped = report(&state, event);
        assert_eq!(wrapped.pane_id, "pane-1");
        assert_eq!(wrapped.token, "tok");
        assert_eq!(wrapped.payload["agent"], "codex");
        assert_eq!(wrapped.payload["event"]["type"], "turn_context");

        state.format = TailFormat::KimiWire;
        let event = wire_event(USAGE_RECORD_LINE.as_bytes()).unwrap();
        assert_eq!(report(&state, event).payload["agent"], "kimi");
    }

    #[test]
    fn find_rollout_walks_the_day_tree_and_prefers_the_newest_match() {
        let root = temp_dir();
        let sid = "019f7683-d6f4-7b00-8e66-00c4694731be";
        let old_day = root.join("2026/07/17");
        let new_day = root.join("2026/07/18");
        fs::create_dir_all(&old_day).unwrap();
        fs::create_dir_all(&new_day).unwrap();
        fs::write(old_day.join(format!("rollout-2026-07-17T01-00-00-{sid}.jsonl")), "x").unwrap();
        fs::write(new_day.join("rollout-2026-07-18T02-00-00-other.jsonl"), "x").unwrap();
        let newest = new_day.join(format!("rollout-2026-07-18T03-00-00-{sid}.jsonl"));
        fs::write(&newest, "x").unwrap();

        assert_eq!(find_rollout_in(&root, sid), Some(newest));
        assert_eq!(find_rollout_in(&root, "0000-none"), None);
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
        assert_eq!(events[0]["type"], "llm.request");
        assert_eq!(events[1]["type"], "usage.record");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tailer_delivers_appends_end_to_end_even_for_a_late_file() {
        let dir = temp_dir();
        let path = dir.join("rollout-live.jsonl");
        let state = Arc::new(Mutex::new(tail(path.clone())));
        let (tx, rx) = mpsc::channel::<UsageReport>();

        // Armed BEFORE the file exists — the dir watch catches its creation.
        let _watcher = spawn_tailer(state, move |r| {
            let _ = tx.send(r);
        })
        .expect("watch");

        fs::write(&path, format!("{TOKEN_COUNT_LINE}\n")).unwrap();
        let first = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("a usage report within 10s");
        assert_eq!(first.payload["event"]["type"], "token_count");

        // A sibling session's rollout in the same day-dir must NOT leak in.
        fs::write(dir.join("rollout-other.jsonl"), format!("{TURN_CONTEXT_LINE}\n"))
            .unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{TURN_CONTEXT_LINE}\n").unwrap();
        drop(file);
        let second = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the appended event within 10s");
        assert_eq!(second.payload["event"]["type"], "turn_context");

        fs::remove_dir_all(&dir).ok();
    }
}
