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

/// The ISO `timestamp` a claude/codex record carries, when it does. One
/// extractor for every dialect that reads it: this field is LOAD-BEARING
/// for the stale-marker guard (`route` forwards it as `sourceAt`), so a
/// key drifting in one copy would silently disarm the guard for that
/// dialect.
fn iso_timestamp(value: &Value) -> Option<SourceTimestamp> {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .map(|at| SourceTimestamp::Iso(at.to_string()))
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
        let source_at = iso_timestamp(&value);
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

    let source_at = iso_timestamp(&value);
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
    let source_at = iso_timestamp(&value);
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

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

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
}
