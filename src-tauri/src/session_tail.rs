//! Usage tailer — per-pane session-file followers (Claude transcripts,
//! Codex rollouts, Kimi wire logs).
//!
//! Claude appends assistant-message usage to its transcript (with repeated
//! rows sharing a message id); Codex embeds rate-limit and token data in its
//! session rollout file (one
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

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
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
    /// Claude transcript `.jsonl`: deduplicated assistant-message usage.
    Claude,
    /// Codex rollout `.jsonl`: `token_count` + `turn_context`.
    Codex,
    /// Kimi wire `.jsonl`: `usage.record` + trimmed `llm.request`.
    KimiWire,
}

impl TailFormat {
    fn agent(self) -> &'static str {
        match self {
            TailFormat::Claude => "claude",
            TailFormat::Codex => "codex",
            TailFormat::KimiWire => "kimi",
        }
    }

    /// Catch-up kinds, context first so the model/window lands before the
    /// numbers it qualifies.
    fn catch_up_order(self) -> &'static [&'static str] {
        match self {
            TailFormat::Claude => &["assistant.usage"],
            TailFormat::Codex => &["turn_context", "token_count"],
            TailFormat::KimiWire => &["llm.request", "usage.record"],
        }
    }

    fn event(self, line: &[u8]) -> Option<TailedEvent> {
        match self {
            TailFormat::Claude => claude_event(line),
            TailFormat::Codex => rollout_event(line),
            TailFormat::KimiWire => wire_event(line),
        }
    }
}

/// Honest time carried by the source event. Codex writes an ISO timestamp on
/// each rollout line; Kimi uses unix milliseconds. The file mtime travels
/// separately as a fallback because parsing and wall-clock validation belong
/// at the application freshness boundary.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
enum SourceTimestamp {
    Iso(String),
    UnixMillis(u64),
}

#[derive(Debug, Clone, PartialEq)]
struct TailedEvent {
    payload: Value,
    source_at: Option<SourceTimestamp>,
    source_mtime_ms: Option<u64>,
}

/// Kimi's running per-tail token cumulative. Kimi writes only per-request
/// counts (`usage.record`), never a session total, and catch-up collapses to
/// the last record — so the sum is held here and stamped onto each event as
/// `sessionTotals`. Each bucket sums SEPARATELY: `inputCacheRead` is the
/// re-read context prefix (occupancy), NOT fresh input, so it never joins the
/// fresh-input total. Stays zero for codex, which carries its own cumulative.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct KimiTotals {
    input_other: u64,
    output: u64,
    input_cache_read: u64,
    input_cache_creation: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ClaudeUsage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
}

impl ClaudeUsage {
    fn max(self, other: Self) -> Self {
        Self {
            input: self.input.max(other.input),
            output: self.output.max(other.output),
            cache_read: self.cache_read.max(other.cache_read),
            cache_creation: self.cache_creation.max(other.cache_creation),
        }
    }

    fn add_assign(&mut self, other: Self) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_creation += other.cache_creation;
    }

    fn subtract(self, other: Self) -> Self {
        Self {
            input: self.input.saturating_sub(other.input),
            output: self.output.saturating_sub(other.output),
            cache_read: self.cache_read.saturating_sub(other.cache_read),
            cache_creation: self.cache_creation.saturating_sub(other.cache_creation),
        }
    }
}

/// Claude repeats one assistant message id across content/tool rows. Keep the
/// per-id maxima (the CLI's documented dedup rule) and a running session sum.
#[derive(Debug, Default, PartialEq, Eq)]
struct ClaudeTotals {
    by_message: HashMap<String, ClaudeUsage>,
    sum: ClaudeUsage,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct SessionTotals {
    kimi: KimiTotals,
    claude: ClaudeTotals,
}

#[derive(Default)]
struct TailCursor {
    offset: u64,
    partial: Vec<u8>,
    /// Inside an abandoned oversized line — drop bytes until its newline.
    skipping: bool,
}

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

/// A pathological line (megabytes with no newline yet) must not buffer
/// forever — past this cap the line is abandoned and the tail resyncs at
/// the next newline. Generous: real usage lines are a few KB.
const MAX_PARTIAL_BYTES: usize = 8 * 1024 * 1024;

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

/// One Claude transcript line → a content-free assistant usage event. The
/// transcript can repeat the same message id as tool/content blocks arrive;
/// deduplication happens while accumulating session totals below.
fn claude_event(line: &[u8]) -> Option<TailedEvent> {
    let value: Value = serde_json::from_slice(line).ok()?;
    if value.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let message = value.get("message")?.as_object()?;
    if message.get("model").and_then(Value::as_str) == Some("<synthetic>") {
        return None;
    }
    let message_id = message.get("id")?.as_str()?;
    if message_id.is_empty() {
        return None;
    }
    let usage = message.get("usage")?.as_object()?;
    let mut trimmed_usage = serde_json::Map::new();
    for key in [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ] {
        if let Some(value) = usage.get(key).and_then(Value::as_u64) {
            trimmed_usage.insert(key.to_string(), value.into());
        }
    }
    if trimmed_usage.is_empty() {
        return None;
    }

    let source_at = value
        .get("timestamp")
        .and_then(Value::as_str)
        .map(|at| SourceTimestamp::Iso(at.to_string()));
    Some(TailedEvent {
        payload: json!({
            "type": "assistant.usage",
            "messageId": message_id,
            "usage": Value::Object(trimmed_usage),
        }),
        source_at,
        source_mtime_ms: None,
    })
}

/// One rollout line → the payload event worth forwarding, if any:
/// `token_count` (usage + rate limits) and `turn_context` (model). Anything
/// else — user messages, tool calls, garbage — is `None`.
fn rollout_event(line: &[u8]) -> Option<TailedEvent> {
    let value: Value = serde_json::from_slice(line).ok()?;
    let source_at = value
        .get("timestamp")
        .and_then(Value::as_str)
        .map(|at| SourceTimestamp::Iso(at.to_string()));
    let payload = match value.get("type")?.as_str()? {
        "event_msg" => {
            let payload = value.get("payload")?;
            if payload.get("type")?.as_str()? == "token_count" {
                payload.clone()
            } else {
                return None;
            }
        }
        "turn_context" => {
            let mut payload = value.get("payload")?.as_object()?.clone();
            payload.insert("type".into(), "turn_context".into());
            Value::Object(payload)
        }
        _ => return None,
    };
    Some(TailedEvent {
        payload,
        source_at,
        source_mtime_ms: None,
    })
}

/// One kimi wire line → the payload event worth forwarding. `usage.record`
/// is small and rides verbatim; `llm.request` is TRIMMED to the two scalars
/// the normalizer needs (model, maxTokens) — the full event carries prompt
/// content, which must never ride the app's event bus.
fn wire_event(line: &[u8]) -> Option<TailedEvent> {
    let value: Value = serde_json::from_slice(line).ok()?;
    let source_at = value
        .get("time")
        .and_then(Value::as_u64)
        .map(SourceTimestamp::UnixMillis);
    let payload = match value.get("type")?.as_str()? {
        "usage.record" => value,
        "llm.request" => {
            let mut trimmed = serde_json::Map::new();
            trimmed.insert("type".into(), "llm.request".into());
            for key in ["model", "maxTokens"] {
                if let Some(v) = value.get(key) {
                    trimmed.insert(key.into(), v.clone());
                }
            }
            Value::Object(trimmed)
        }
        _ => return None,
    };
    Some(TailedEvent {
        payload,
        source_at,
        source_mtime_ms: None,
    })
}

/// Read appended bytes in fixed-size chunks, returning events from complete
/// lines while carrying at most one bounded partial line. No prefix is ever
/// drained from a Vec, so catch-up remains linear even for large transcripts.
/// The bool reports a truncated/rotated file.
fn drain_file(
    path: &std::path::Path,
    cursor: &mut TailCursor,
    format: TailFormat,
) -> (Vec<TailedEvent>, bool) {
    let Ok(mut file) = File::open(path) else {
        return (Vec::new(), false);
    };
    let (len, file_mtime_ms) = file
        .metadata()
        .map(|metadata| {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64);
            (metadata.len(), modified)
        })
        .unwrap_or((0, None));
    let rotated = len < cursor.offset;
    if rotated {
        cursor.offset = 0;
        cursor.partial.clear();
        cursor.skipping = false;
    }
    if len == cursor.offset || file.seek(SeekFrom::Start(cursor.offset)).is_err() {
        return (Vec::new(), rotated);
    }

    let mut events = Vec::new();
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        let Ok(read) = file.read(&mut chunk) else {
            break;
        };
        if read == 0 {
            break;
        }
        cursor.offset += read as u64;
        parse_chunk(cursor, &chunk[..read], format, file_mtime_ms, &mut events);
    }
    (events, rotated)
}

fn parse_chunk(
    cursor: &mut TailCursor,
    chunk: &[u8],
    format: TailFormat,
    file_mtime_ms: Option<u64>,
    events: &mut Vec<TailedEvent>,
) {
    let mut start = 0;
    if cursor.skipping {
        let Some(nl) = chunk.iter().position(|byte| *byte == b'\n') else {
            return;
        };
        cursor.skipping = false;
        start = nl + 1;
    }

    while let Some(relative_nl) = chunk[start..].iter().position(|byte| *byte == b'\n') {
        let nl = start + relative_nl;
        let fragment = &chunk[start..nl];
        if cursor.partial.len() + fragment.len() <= MAX_PARTIAL_BYTES {
            if cursor.partial.is_empty() {
                push_event(format, fragment, file_mtime_ms, events);
            } else {
                cursor.partial.extend_from_slice(fragment);
                push_event(format, &cursor.partial, file_mtime_ms, events);
                cursor.partial.clear();
            }
        } else {
            cursor.partial.clear();
        }
        start = nl + 1;
    }

    let remainder = &chunk[start..];
    if cursor.partial.len() + remainder.len() > MAX_PARTIAL_BYTES {
        cursor.partial.clear();
        cursor.skipping = true;
    } else {
        cursor.partial.extend_from_slice(remainder);
    }
}

fn push_event(
    format: TailFormat,
    line: &[u8],
    file_mtime_ms: Option<u64>,
    events: &mut Vec<TailedEvent>,
) {
    if let Some(mut event) = format.event(line) {
        event.source_mtime_ms = file_mtime_ms;
        if event.source_at.is_none() {
            event.source_at = file_mtime_ms.map(SourceTimestamp::UnixMillis);
        }
        events.push(event);
    }
}

/// Drain only the session's root file. A root rotation is a fresh session
/// generation and resets the running totals.
fn drain(state: &mut TailState) -> Vec<TailedEvent> {
    let (events, rotated) = drain_file(&state.path, &mut state.root, state.format);
    if rotated {
        state.totals = SessionTotals::default();
    }
    events
}

/// Claude subagents write their own assistant rows next to the root
/// transcript. Discover them every poll because the directory and files can
/// appear after the watch is armed.
fn claude_subagent_paths(root: &std::path::Path) -> Vec<PathBuf> {
    let directory = root.with_extension("").join("subagents");
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut paths = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let jsonl = path.extension().and_then(|ext| ext.to_str()) == Some("jsonl");
            let file = entry.file_type().ok().is_some_and(|kind| kind.is_file());
            (jsonl && file).then_some(path)
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn drain_all(state: &mut TailState) -> Vec<TailedEvent> {
    let mut events = drain(state);
    if state.format != TailFormat::Claude {
        return events;
    }
    let paths = claude_subagent_paths(&state.path);
    for path in paths {
        let cursor = state.subagents.entry(path.clone()).or_default();
        let (mut appended, _) = drain_file(&path, cursor, TailFormat::Claude);
        events.append(&mut appended);
    }
    events
}

/// The catch-up summary: of everything drained from an existing file, only
/// the LAST of each kind matters, emitted in the format's declared order.
fn last_of_each(events: Vec<TailedEvent>, order: &[&str]) -> Vec<TailedEvent> {
    let mut last = vec![None; order.len()];
    for event in events {
        let Some(kind) = event.payload.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        if let Some(slot) = order.iter().position(|k| *k == kind) {
            last[slot] = Some(event);
        }
    }
    last.into_iter().flatten().collect()
}

/// Fold per-request/message token buckets into running session cumulatives and
/// stamp `sessionTotals` onto the event. Kimi sums every usage record. Claude
/// deduplicates repeated assistant rows by message id, retaining each bucket's
/// maximum. Codex carries a native cumulative and passes through untouched.
fn accumulate_session_totals(
    totals: &mut SessionTotals,
    format: TailFormat,
    event: &mut TailedEvent,
) {
    let kind = event.payload.get("type").and_then(Value::as_str);
    match (format, kind) {
        (TailFormat::KimiWire, Some("usage.record")) => {
            let usage = event.payload.get("usage");
            let bucket = |key: &str| {
                usage
                    .and_then(|u| u.get(key))
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            };
            totals.kimi.input_other += bucket("inputOther");
            totals.kimi.output += bucket("output");
            totals.kimi.input_cache_read += bucket("inputCacheRead");
            totals.kimi.input_cache_creation += bucket("inputCacheCreation");
            if let Some(object) = event.payload.as_object_mut() {
                object.insert(
                    "sessionTotals".to_string(),
                    json!({
                        "inputOther": totals.kimi.input_other,
                        "output": totals.kimi.output,
                        "inputCacheRead": totals.kimi.input_cache_read,
                        "inputCacheCreation": totals.kimi.input_cache_creation,
                    }),
                );
            }
        }
        (TailFormat::Claude, Some("assistant.usage")) => {
            let Some(message_id) = event
                .payload
                .get("messageId")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                return;
            };
            let usage = event.payload.get("usage");
            let bucket = |key: &str| {
                usage
                    .and_then(|u| u.get(key))
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            };
            let incoming = ClaudeUsage {
                input: bucket("input_tokens"),
                output: bucket("output_tokens"),
                cache_read: bucket("cache_read_input_tokens"),
                cache_creation: bucket("cache_creation_input_tokens"),
            };
            let previous = totals
                .claude
                .by_message
                .get(&message_id)
                .copied()
                .unwrap_or_default();
            let next = previous.max(incoming);
            totals.claude.sum.add_assign(next.subtract(previous));
            totals.claude.by_message.insert(message_id, next);

            if let Some(object) = event.payload.as_object_mut() {
                object.insert(
                    "sessionTotals".to_string(),
                    json!({
                        "input_tokens": totals.claude.sum.input,
                        "output_tokens": totals.claude.sum.output,
                        "cache_read_input_tokens": totals.claude.sum.cache_read,
                        "cache_creation_input_tokens": totals.claude.sum.cache_creation,
                    }),
                );
            }
        }
        _ => {}
    }
}

/// Wrap one session-file event into the bridge's wire shape. `agent` and
/// `catchUp` are HOST-owned transport keys on the payload: `catchUp` marks
/// events replayed from the EXISTING file at arm time — the store must not
/// let that replay outrank live data.
fn report(state: &TailState, event: TailedEvent, catch_up: bool) -> UsageReport {
    let mut payload = json!({
        "agent": state.format.agent(),
        "event": event.payload,
        "catchUp": catch_up,
    });
    if let Some(source_at) = event.source_at {
        payload["sourceAt"] = json!(source_at);
    }
    if let Some(source_mtime_ms) = event.source_mtime_ms {
        payload["sourceMtimeMs"] = json!(source_mtime_ms);
    }
    UsageReport {
        pane_id: state.pane_id.clone(),
        token: state.token.clone(),
        payload,
    }
}

/// Start the poll thread for one tail. Delivery is a plain closure so the
/// pipeline is testable without a Tauri app handle. `drain` already
/// no-ops when the file is missing or unchanged, so a tick is one cheap
/// open+stat.
fn spawn_tailer(
    state: Arc<Mutex<TailState>>,
    interval: Duration,
    deliver: impl Fn(UsageReport) + Send + 'static,
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
                for mut event in drain_all(&mut s) {
                    accumulate_session_totals(&mut s.totals, format, &mut event);
                    deliver(report(&s, event, false));
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
        log::debug!(
            "usage tail: pane={} live {} event",
            payload.pane_id,
            payload.payload["event"]["type"]
        );
        let _ = emitter.emit(USAGE_REPORT_EVENT, &payload);
    })?;
    let caught_up = {
        let mut s = state.lock().expect("tail state poisoned");
        // Fold the WHOLE catch-up drain into the running cumulative in file
        // order BEFORE last_of_each collapses it — the surviving last
        // usage.record then carries the session total of everything before it.
        let mut drained = drain_all(&mut s);
        for event in &mut drained {
            accumulate_session_totals(&mut s.totals, format, event);
        }
        let events = last_of_each(drained, format.catch_up_order());
        let count = events.len();
        for event in events {
            let _ = app.emit(USAGE_REPORT_EVENT, &report(&s, event, true));
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

/// Every `rollout-*.jsonl` under the day-partitioned
/// `~/.codex/sessions/YYYY/MM/DD/` tree, newest mtime first.
fn rollouts_newest_first(root: &std::path::Path) -> Vec<(std::time::SystemTime, PathBuf)> {
    let mut found = Vec::new();
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
            let is_rollout = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"));
            if !is_rollout {
                continue;
            }
            let modified = file
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            found.push((modified, path));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found
}

/// Locate a codex session's rollout by its recorded id — the fallback for
/// TUI resumes: codex (observed on 0.144.5) fires SessionStart in `exec`
/// and `exec resume` but NOT in the interactive `resume`, so no binding
/// carries the path. Rollout names end `-<session_id>.jsonl`; the newest
/// match wins.
fn find_rollout_in(root: &std::path::Path, session_id: &str) -> Option<PathBuf> {
    let suffix = format!("-{session_id}.jsonl");
    rollouts_newest_first(root)
        .into_iter()
        .map(|(_, path)| path)
        .find(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(&suffix))
        })
}

/// The last usage event of the newest rollout on disk, its source time and
/// that FILE's mtime fallback. This is the boot catch-up: codex runs outside
/// KeepDeck too, so its sessions dir can know fresher limits than cache.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRollout {
    event: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_at: Option<SourceTimestamp>,
    mtime_ms: u64,
}

/// A just-launched session writes its rollout before any turn, so the
/// newest file may carry no usage while an older one holds the account's
/// real last word — walk newest-first until a `token_count` shows up, but
/// never scan an unbounded history for an account that has none.
const BOOT_SWEEP_MAX_FILES: usize = 10;

fn latest_rollout_usage_in(root: &std::path::Path) -> Option<LatestRollout> {
    let files = rollouts_newest_first(root);
    for (modified, path) in files.into_iter().take(BOOT_SWEEP_MAX_FILES) {
        let mut state = TailState {
            path,
            pane_id: String::new(),
            token: String::new(),
            format: TailFormat::Codex,
            root: TailCursor::default(),
            subagents: HashMap::new(),
            totals: SessionTotals::default(),
        };
        let event = last_of_each(drain(&mut state), TailFormat::Codex.catch_up_order())
            .into_iter()
            .find(|e| e.payload.get("type").and_then(|t| t.as_str()) == Some("token_count"));
        if let Some(event) = event {
            let mtime_ms = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            return Some(LatestRollout {
                event: event.payload,
                source_at: event.source_at,
                mtime_ms,
            });
        }
    }
    None
}

/// The boot catch-up command. `(async)` — it may read several session
/// files. The event rides verbatim (payloads are opaque to Rust); source
/// time (or mtime), never receipt time, is its honest age.
#[tauri::command(async)]
pub fn usage_latest_codex_rollout() -> Option<LatestRollout> {
    let home = std::env::var_os("HOME")?;
    latest_rollout_usage_in(&PathBuf::from(home).join(".codex/sessions"))
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
        let mut drained = drain_all(&mut state);
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
        for mut event in drain_all(&mut state) {
            accumulate_session_totals(&mut state.totals, TailFormat::Claude, &mut event);
        }

        let subagents = dir.join("session-late/subagents");
        fs::create_dir_all(&subagents).unwrap();
        let subagent = CLAUDE_ASSISTANT_LINE
            .replace("msg-1", "msg-late")
            .replace(r#""output_tokens":30"#, r#""output_tokens":5"#);
        fs::write(subagents.join("agent-late.jsonl"), format!("{subagent}\n")).unwrap();

        let mut appended = drain_all(&mut state);
        assert_eq!(appended.len(), 1);
        accumulate_session_totals(&mut state.totals, TailFormat::Claude, &mut appended[0]);
        assert_eq!(appended[0].payload["sessionTotals"]["output_tokens"], 35);
        assert!(drain_all(&mut state).is_empty());

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
        let (tx, rx) = mpsc::channel::<UsageReport>();
        let _watcher = spawn_tailer(state, Duration::from_millis(150), move |r| {
            let _ = tx.send(r);
        })
        .expect("watch");

        write!(file, "{TOKEN_COUNT_LINE}\n").unwrap();
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
        let (tx, rx) = mpsc::channel::<UsageReport>();

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
        write!(file, "{TURN_CONTEXT_LINE}\n").unwrap();
        drop(file);
        let second = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the appended event within 10s");
        assert_eq!(second.payload["event"]["type"], "turn_context");

        fs::remove_dir_all(&dir).ok();
    }
}
