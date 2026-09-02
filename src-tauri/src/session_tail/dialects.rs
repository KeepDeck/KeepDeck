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

/// One condition on a record's field, named by a dotted path (mirrors the
/// TS wire).
///
/// Two-valued on purpose: a field equals a string, or a field is merely
/// there. The path is traversal and nothing more — this side stays a
/// comparison rather than becoming an interpreter.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordMatch {
    /// `type`, or `payload.type` — codex records an abort one level down.
    pub key: String,
    /// The exact string it must hold. Absent = presence is enough.
    pub equals: Option<String>,
}

/// Walk a dotted path. Anything that is not an object on the way down ends
/// the walk, so a store that changed a field's shape reads as absence.
fn at<'a>(record: &'a Value, path: &str) -> Option<&'a Value> {
    let mut held = record;
    for segment in path.split('.') {
        held = held.as_object()?.get(segment)?;
    }
    Some(held)
}

/// What a plugin's dialect asks to be carried out of its store.
///
/// This is what lets THIS side stop understanding the store. It compares the
/// keys it was given and copies the ones it was named; it cannot tell an
/// interrupt from a tool result, and does not need to. Which records mean
/// what is answered on the other side, by the dialect that wrote this.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TailWatch {
    /// Every clause must hold.
    #[serde(rename = "match")]
    pub clauses: Vec<RecordMatch>,
    /// Top-level keys to copy. NOTHING else leaves the store — which is why
    /// a dialect that never names a message field cannot carry a message
    /// out of a transcript by accident.
    pub keep: Vec<String>,
    /// Which channel the carried record belongs on. DECLARED, because
    /// deriving it would mean reading the record — and not reading records is
    /// the whole of this side's job.
    pub lane: TailLane,
}

/// The two questions a session store answers. This side does not know which
/// one any record answers; it forwards what it was told.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TailLane {
    Status,
    Usage,
}

/// The payload type a carried record travels under. One name for every
/// dialect: this side is not saying what happened, only that a record its
/// watcher was told to carry has arrived.
pub(super) const CARRIED_RECORD: &str = "store.record";

/// Test one line against a watch and carry the named fields, or nothing.
///
/// Runs BEFORE a format's own arms, and independently of them: the arms
/// still extract usage, which has not moved yet. A line can satisfy both,
/// and then it travels twice — once as this side's reading of the numbers,
/// once as the record the other side will read for itself.
pub(super) fn watched_event(line: &[u8], watches: &[TailWatch]) -> Option<TailedEvent> {
    let value: Value = serde_json::from_slice(line).ok()?;
    value.as_object()?;
    // First match carries. A dialect that wants two readings of one record
    // says so on its own side, where saying so is cheap; here, trying on
    // after a hit would send the same record twice under two lanes.
    watches.iter().find_map(|watch| carry(&value, watch))
}

fn carry(value: &Value, watch: &TailWatch) -> Option<TailedEvent> {
    for clause in &watch.clauses {
        let held = at(value, &clause.key);
        let ok = match &clause.equals {
            Some(want) => held.and_then(Value::as_str) == Some(want.as_str()),
            // Presence, and a blank is not presence: a key written empty is
            // how several stores say "no value", and carrying those would
            // hand the dialect records that say nothing.
            None => match held {
                None | Some(Value::Null) => false,
                Some(Value::String(text)) => !text.is_empty(),
                Some(_) => true,
            },
        };
        if !ok {
            return None;
        }
    }
    // A dotted name survives as a dotted KEY rather than rebuilding the
    // nesting: what was asked for is what arrives, under the name it was
    // asked for, and nothing invites a dialect to expect the rest of a shape.
    let mut kept = serde_json::Map::new();
    for key in &watch.keep {
        if let Some(held) = at(value, key) {
            kept.insert(key.clone(), held.clone());
        }
    }
    Some(TailedEvent {
        payload: json!({
            "type": CARRIED_RECORD,
            "record": Value::Object(kept),
            "lane": match watch.lane {
                TailLane::Status => "status",
                TailLane::Usage => "usage",
            },
        }),
        // Provenance stays this side's job: the freshness guard is about the
        // deck's clock against the store's, which is a fact about following
        // a file rather than about any agent's format.
        source_at: iso_timestamp(value),
        source_mtime_ms: None,
        root: true,
    })
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
    // The interrupt marker used to be read here: this side looked for
    // `interruptedMessageId`, decided the record meant the user's Esc, and
    // minted a word for it. Which records of a claude transcript mean what
    // is claude's plugin's to say, and it now says it — the record travels
    // as itself, carried by the watch its dialect declared, and the meaning
    // is applied on the side that knows the format.
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
                // `turn_aborted` used to be read here, and is not any more.
                // Which of codex's records mean a turn ended, and which of
                // its abort reasons is a person's hand rather than the model
                // giving up, is codex's plugin's to say — it says it through
                // the watch it declares, and the record travels as itself.
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

    // Interrupts ride on the record's STRUCTURE, never its prose. claude's
    // marker now travels as the record itself, carried by the watch its own
    // plugin declared; codex's `turn_aborted` is still read here, and moves
    // when its plugin does.
    #[test]
    fn an_interrupt_travels_as_the_record_its_dialect_asked_for() {
        let claude_marker = format!(
            r#"{{"type":"user","interruptedMessageId":"msg-7","timestamp":"{SOURCE_ISO}","message":{{"role":"user","content":[{{"type":"text","text":"[Request interrupted by user]"}}]}}}}"#
        );
        // THIS SIDE no longer reads claude's marker. What a transcript
        // record means is claude's plugin's to say, and it says it through a
        // watch: this side compares the keys it was handed and copies the
        // ones it was named, without knowing that any of it is an interrupt.
        assert_eq!(claude_event(claude_marker.as_bytes()), None);

        let watch = TailWatch {
            clauses: vec![
                RecordMatch {
                    key: "type".into(),
                    equals: Some("user".into()),
                },
                RecordMatch {
                    key: "interruptedMessageId".into(),
                    equals: None,
                },
            ],
            keep: vec![
                "type".into(),
                "interruptedMessageId".into(),
                "timestamp".into(),
            ],
            lane: TailLane::Status,
        };
        let event = watched_event(claude_marker.as_bytes(), std::slice::from_ref(&watch)).expect("carried");
        assert_eq!(event.payload["type"], CARRIED_RECORD);
        // The named fields and NOTHING else: the record in the fixture
        // carries a message, and it does not travel.
        assert_eq!(
            event.payload["record"],
            serde_json::json!({
                "type": "user",
                "interruptedMessageId": "msg-7",
                "timestamp": SOURCE_ISO,
            })
        );
        // Provenance stays this side's: the freshness guard is about the
        // deck's clock against the store's, not about anyone's format.
        assert_eq!(
            event.source_at,
            Some(SourceTimestamp::Iso(SOURCE_ISO.into()))
        );
        // An ordinary user record — even one QUOTING the marker text — is
        // not carried, because the key it is matched on is absent.
        assert_eq!(
            watched_event(
                br#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
                std::slice::from_ref(&watch)
            ),
            None
        );
        // A key written blank is not presence: several stores say "no
        // value" that way, and carrying those hands the other side records
        // that say nothing.
        assert_eq!(
            watched_event(br#"{"type":"user","interruptedMessageId":""}"#, std::slice::from_ref(&watch)),
            None
        );

        let codex_marker = format!(
            r#"{{"timestamp":"{SOURCE_ISO}","type":"event_msg","payload":{{"type":"turn_aborted","turn_id":"t-1","reason":"interrupted"}}}}"#
        );
        // This side no longer reads codex's abort either.
        assert_eq!(rollout_event(codex_marker.as_bytes()), None);

        // It carries it, through a NESTED clause. codex hides the abort one
        // level down, inside a class that also carries its usage numbers and
        // the assistant's own text — matching the class alone would put a
        // session's output on the bus to learn one fact.
        let codex_watch = TailWatch {
            clauses: vec![
                RecordMatch {
                    key: "type".into(),
                    equals: Some("event_msg".into()),
                },
                RecordMatch {
                    key: "payload.type".into(),
                    equals: Some("turn_aborted".into()),
                },
            ],
            keep: vec![
                "timestamp".into(),
                "payload.type".into(),
                "payload.reason".into(),
            ],
            lane: TailLane::Status,
        };
        let event = watched_event(codex_marker.as_bytes(), std::slice::from_ref(&codex_watch)).expect("carried");
        // Dotted names survive as dotted KEYS: what was asked for arrives
        // under the name it was asked for, and `turn_id` — which nobody
        // named — does not travel.
        assert_eq!(
            event.payload["record"],
            serde_json::json!({
                "timestamp": SOURCE_ISO,
                "payload.type": "turn_aborted",
                "payload.reason": "interrupted",
            })
        );
        // The class alone is not enough: usage rides the same one.
        let token_count = r#"{"type":"event_msg","payload":{"type":"token_count","info":{}}}"#;
        assert_eq!(watched_event(token_count.as_bytes(), std::slice::from_ref(&codex_watch)), None);
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
