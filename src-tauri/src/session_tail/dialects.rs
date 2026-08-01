//! The three session-file dialects: which lines matter, what event each
//! becomes, and the catch-up policy over those events. Pure parsing — no
//! files, no threads, no Tauri.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

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
    pub(super) fn agent(self) -> &'static str {
        match self {
            TailFormat::Claude => "claude",
            TailFormat::Codex => "codex",
            TailFormat::KimiWire => "kimi",
        }
    }

    /// Catch-up kinds, context first so the model/window lands before the
    /// numbers it qualifies.
    pub(super) fn catch_up_order(self) -> &'static [&'static str] {
        match self {
            TailFormat::Claude => &["assistant.usage"],
            TailFormat::Codex => &["turn_context", "token_count"],
            TailFormat::KimiWire => &["llm.request", "usage.record"],
        }
    }

    pub(super) fn event(self, line: &[u8]) -> Option<TailedEvent> {
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
pub(super) enum SourceTimestamp {
    Iso(String),
    UnixMillis(u64),
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct TailedEvent {
    pub(super) payload: Value,
    pub(super) source_at: Option<SourceTimestamp>,
    pub(super) source_mtime_ms: Option<u64>,
    /// From the session's ROOT file (false = a claude subagent transcript).
    /// An interrupt marker is pane-level only when the ROOT turn was
    /// aborted; a subagent's own abort must not relabel the pane.
    pub(super) root: bool,
}

/// One Claude transcript line → a content-free assistant usage event, or the
/// user-interrupt marker. The transcript can repeat the same message id as
/// tool/content blocks arrive; deduplication happens while accumulating
/// session totals.
pub(super) fn claude_event(line: &[u8]) -> Option<TailedEvent> {
    let value: Value = serde_json::from_slice(line).ok()?;
    let kind = value.get("type")?.as_str()?;
    // The interrupt marker: claude pushes NO hook when the user aborts a
    // turn (Esc) — the transcript is the only witness. Keyed on the
    // STRUCTURED `interruptedMessageId` field of the appended user record,
    // never on the "[Request interrupted…]" text, so an assistant merely
    // quoting the phrase cannot trip it.
    if kind == "user" {
        let interrupted = value
            .get("interruptedMessageId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty());
        if !interrupted {
            return None;
        }
        let source_at = value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(|at| SourceTimestamp::Iso(at.to_string()));
        return Some(TailedEvent {
            // claude's marker exists only for the user's own Esc — the
            // reason is fixed, spelled out for one wire shape with codex.
            payload: json!({ "type": "session.interrupt", "reason": "interrupted" }),
            source_at,
            source_mtime_ms: None,
            root: true,
        });
    }
    if kind != "assistant" {
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
        root: true,
    })
}

/// One rollout line → the payload event worth forwarding, if any:
/// `token_count` (usage + rate limits), `turn_context` (model), and the
/// `turn_aborted` interrupt marker. Anything else — user messages, tool
/// calls, garbage — is `None`.
pub(super) fn rollout_event(line: &[u8]) -> Option<TailedEvent> {
    let value: Value = serde_json::from_slice(line).ok()?;
    let source_at = value
        .get("timestamp")
        .and_then(Value::as_str)
        .map(|at| SourceTimestamp::Iso(at.to_string()));
    let payload = match value.get("type")?.as_str()? {
        "event_msg" => {
            let payload = value.get("payload")?;
            match payload.get("type")?.as_str()? {
                "token_count" => payload.clone(),
                // codex pushes NO hook on a user interrupt; the rollout's
                // `turn_aborted` record is the witness. The record TYPE is
                // the marker (assistant text can't trip it). The reason
                // rides along: only "interrupted" is the user's hand — the
                // other aborts still END the turn, but labelling them
                // "Interrupted" would claim an Esc nobody pressed.
                "turn_aborted" => json!({
                    "type": "session.interrupt",
                    "reason": payload.get("reason").and_then(Value::as_str).unwrap_or("interrupted"),
                }),
                _ => return None,
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
        root: true,
    })
}

/// One kimi wire line → the payload event worth forwarding. `usage.record`
/// is small and rides verbatim; `llm.request` is TRIMMED to the two scalars
/// the normalizer needs (model, maxTokens) — the full event carries prompt
/// content, which must never ride the app's event bus.
pub(super) fn wire_event(line: &[u8]) -> Option<TailedEvent> {
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
        root: true,
    })
}

/// Claude subagents write their own assistant rows next to the root
/// transcript. Discover them every poll because the directory and files can
/// appear after the watch is armed.
pub(super) fn claude_subagent_paths(root: &std::path::Path) -> Vec<PathBuf> {
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

/// The catch-up summary: of everything drained from an existing file, only
/// the LAST of each kind matters, emitted in the format's declared order.
pub(super) fn last_of_each(events: Vec<TailedEvent>, order: &[&str]) -> Vec<TailedEvent> {
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
