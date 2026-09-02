//! The three session-file dialects: which lines matter, what event each
//! becomes, and the catch-up policy over those events. Pure parsing — no
//! files, no threads, no Tauri.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

use super::totals::Folds;

/// The name the webview still calls a store by.
///
/// It used to be the dialect: each variant owned a line filter, a catch-up
/// order and a set of parse arms, which is how three CLIs' formats came to
/// live in the side that was meant to know none of them. All of that is
/// declared by the plugins now, and what is left is a label — the `agent`
/// tag reports ride under, and the one cold path that still walks a
/// particular CLI's sessions tree. Both are topology, and both are going.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TailFormat {
    Claude,
    Codex,
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
///
/// One walker for both readers of a descriptor — the one that decides
/// whether a record is carried, and the one that adds its buckets up. Two
/// copies would be two chances for a path to mean something slightly
/// different depending on which half of the same declaration read it.
pub(super) fn at<'a>(record: &'a Value, path: &str) -> Option<&'a Value> {
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
    /// A running total to fold over these records and stamp onto each.
    /// Absent for a store that carries its own cumulative, or for records
    /// that are not about numbers at all.
    #[serde(default)]
    pub sum: Option<TailSum>,
}

/// The arithmetic a dialect asks for over the records one watch carries.
///
/// It lives on this side for one reason: the numbers are HERE. A session
/// store is drained once at arming, and only the last record of each watch
/// survives that drain — so a total has to be made while the rows are still
/// in hand, and what crosses is the sum rather than twelve thousand rows.
///
/// It stays DATA for the opposite reason: which buckets a total is made of,
/// and whether repeated rows are one message or several, are facts about one
/// CLI's format. This side adds up the fields it was named and stamps the
/// result under the name it was given, without knowing that any of it is
/// tokens.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TailSum {
    /// Stamped name → the dotted path it is read from. Buckets are held
    /// SEPARATELY: a re-read context prefix is not fresh input, and adding
    /// them together would report a session as having spent what it re-sent.
    pub buckets: BTreeMap<String, String>,
    /// The field saying which message a row belongs to, for a store that
    /// writes one message as several rows. Rows sharing it are held at each
    /// bucket's maximum and only their GROWTH joins the total; absent, every
    /// row is its own event and simply adds.
    #[serde(default)]
    pub dedup_by: Option<String>,
    /// The key the running total is stamped under on the carried record.
    pub stamp_as: String,
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
pub(super) fn watched_event(
    line: &[u8],
    watches: &[TailWatch],
    folds: &mut Folds,
) -> Option<TailedEvent> {
    let value: Value = serde_json::from_slice(line).ok()?;
    value.as_object()?;
    // First match carries. A dialect that wants two readings of one record
    // says so on its own side, where saying so is cheap; here, trying on
    // after a hit would send the same record twice under two lanes.
    watches
        .iter()
        .enumerate()
        .find_map(|(slot, watch)| carry(&value, watch, slot, folds))
}

fn carry(value: &Value, watch: &TailWatch, slot: usize, folds: &mut Folds) -> Option<TailedEvent> {
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
    // The total is folded from the ORIGINAL record, not from the projection:
    // a dialect should not have to `keep` a field merely to have it counted,
    // and what it keeps is about what the other side reads.
    if let Some(sum) = &watch.sum {
        kept.insert(sum.stamp_as.clone(), folds.fold(slot, sum, value));
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
        source_at: source_timestamp(value),
        source_mtime_ms: None,
        root: true,
        slot: Some(slot),
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

/// When a record says it was written, in whichever of the two ways a store
/// writes it: an ISO `timestamp`, or unix milliseconds under `time`.
///
/// Provenance is this side's, which is why reading two field names here is
/// not the format knowledge this module spent itself getting rid of: the
/// stale-marker guard compares the DECK's clock against the store's, a fact
/// about following a file that is true of every agent. A record that says
/// neither travels with the file's mtime, which `reader` supplies.
fn source_timestamp(value: &Value) -> Option<SourceTimestamp> {
    if let Some(iso) = value.get("timestamp").and_then(Value::as_str) {
        return Some(SourceTimestamp::Iso(iso.to_string()));
    }
    value
        .get("time")
        .and_then(Value::as_u64)
        .map(SourceTimestamp::UnixMillis)
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
    /// Which watch carried this record — the only thing catch-up can
    /// collapse on, now that every carried record travels under one type.
    /// `None` for events this side minted itself.
    pub(super) slot: Option<usize>,
}

// The three parse arms stood here: which claude transcript lines carried
// usage and what to trim them to, which codex rollout payloads were worth
// forwarding, which kimi wire records were small enough to ride verbatim.
// Every one of them was a statement about somebody else's format, made by
// the side that reads the bytes. They are declarations now — a watch names
// the records and the fields, a sum names the arithmetic — and this file
// compares keys and copies values without knowing whose store it is in.

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
/// the LAST record of each watch matters.
///
/// Collapsing on the WATCH rather than on a record kind, because every
/// carried record now travels under one type and there is nothing else left
/// to tell two of them apart. The watch list's own order is the order they
/// come back in, which is load-bearing: a dialect declares the watch
/// carrying its model and context window BEFORE the one carrying its
/// numbers, so the window lands before the counts it qualifies.
///
/// Status-lane records do not survive at all. A record read out of the
/// existing file describes a turn that ended before this deck was looking,
/// and replaying it would end the turn running now — so the replay stops
/// here, in the one place that sees the whole drain, rather than at each of
/// the places that would otherwise have to remember.
pub(super) fn last_of_each(events: Vec<TailedEvent>, watches: &[TailWatch]) -> Vec<TailedEvent> {
    let mut last: Vec<Option<TailedEvent>> = (0..watches.len()).map(|_| None).collect();
    for event in events {
        let Some(slot) = event.slot else { continue };
        let Some(watch) = watches.get(slot) else { continue };
        if watch.lane == TailLane::Status {
            continue;
        }
        last[slot] = Some(event);
    }
    last.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    fn declare(clauses: Vec<RecordMatch>, keep: &[&str], lane: TailLane) -> TailWatch {
        TailWatch {
            clauses,
            keep: keep.iter().map(|k| k.to_string()).collect(),
            lane,
            sum: None,
        }
    }

    fn equals(key: &str, value: &str) -> RecordMatch {
        RecordMatch {
            key: key.into(),
            equals: Some(value.into()),
        }
    }

    fn present(key: &str) -> RecordMatch {
        RecordMatch {
            key: key.into(),
            equals: None,
        }
    }

    fn carried(line: &[u8], watches: &[TailWatch]) -> Option<TailedEvent> {
        watched_event(line, watches, &mut Folds::default())
    }

    // Interrupts ride on the record's STRUCTURE, never its prose — and this
    // side no longer knows that any of it is an interrupt. It compares the
    // keys it was handed and copies the ones it was named.
    #[test]
    fn an_interrupt_travels_as_the_record_its_dialect_asked_for() {
        let claude_marker = format!(
            r#"{{"type":"user","interruptedMessageId":"msg-7","timestamp":"{SOURCE_ISO}","message":{{"role":"user","content":[{{"type":"text","text":"[Request interrupted by user]"}}]}}}}"#
        );
        let watch = declare(
            vec![equals("type", "user"), present("interruptedMessageId")],
            &["type", "interruptedMessageId", "timestamp"],
            TailLane::Status,
        );
        let event =
            carried(claude_marker.as_bytes(), std::slice::from_ref(&watch)).expect("carried");
        assert_eq!(event.payload["type"], CARRIED_RECORD);
        assert_eq!(event.slot, Some(0));
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
            carried(
                br#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
                std::slice::from_ref(&watch)
            ),
            None
        );
        // A key written blank is not presence: several stores say "no
        // value" that way, and carrying those hands the other side records
        // that say nothing.
        assert_eq!(
            carried(
                br#"{"type":"user","interruptedMessageId":""}"#,
                std::slice::from_ref(&watch)
            ),
            None
        );

        // A NESTED clause, for a store that hides the fact one level down
        // inside a class that also carries its usage numbers and the
        // assistant's own text — matching the class alone would put a
        // session's output on the bus to learn one fact.
        let codex_marker = format!(
            r#"{{"timestamp":"{SOURCE_ISO}","type":"event_msg","payload":{{"type":"turn_aborted","turn_id":"t-1","reason":"interrupted"}}}}"#
        );
        let codex_watch = declare(
            vec![
                equals("type", "event_msg"),
                equals("payload.type", "turn_aborted"),
            ],
            &["timestamp", "payload.type", "payload.reason"],
            TailLane::Status,
        );
        let event =
            carried(codex_marker.as_bytes(), std::slice::from_ref(&codex_watch)).expect("carried");
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
        assert_eq!(
            carried(token_count.as_bytes(), std::slice::from_ref(&codex_watch)),
            None
        );
    }

    // A store's content must not be able to ride out of it, and the reason
    // is structural rather than remembered: a field nobody named was never
    // copied.
    #[test]
    fn only_the_named_fields_leave_the_store() {
        let watch = declare(
            vec![equals("type", "assistant")],
            &["message.id", "message.usage.output_tokens"],
            TailLane::Usage,
        );
        let event = carried(
            CLAUDE_ASSISTANT_LINE.as_bytes(),
            std::slice::from_ref(&watch),
        )
        .expect("carried");
        assert_eq!(
            event.payload["record"],
            serde_json::json!({
                "message.id": "msg-1",
                "message.usage.output_tokens": 30,
            })
        );
        assert!(
            !event.payload.to_string().contains("SECRET"),
            "transcript content must never ride the event bus"
        );
    }

    // The reader adds the numbers it was NAMED and stamps them under the
    // name it was given. It cannot tell that any of this is tokens.
    #[test]
    fn a_watch_that_declares_a_sum_carries_a_running_total() {
        let mut watch = declare(
            vec![equals("type", "usage.record")],
            &["type"],
            TailLane::Usage,
        );
        watch.sum = Some(TailSum {
            buckets: BTreeMap::from([("output".to_string(), "usage.output".to_string())]),
            dedup_by: None,
            stamp_as: "sessionTotals".to_string(),
        });
        let watches = std::slice::from_ref(&watch);
        let mut folds = Folds::default();

        let first = watched_event(USAGE_RECORD_LINE.as_bytes(), watches, &mut folds).unwrap();
        assert_eq!(first.payload["record"]["sessionTotals"]["output"], 300);
        // The SECOND record carries the running total, not its own count —
        // which is what makes the last record of a catch-up drain enough.
        let second = watched_event(USAGE_RECORD_LINE.as_bytes(), watches, &mut folds).unwrap();
        assert_eq!(second.payload["record"]["sessionTotals"]["output"], 600);
    }

    // Two ways a store says when: an ISO stamp, or unix milliseconds.
    #[test]
    fn a_records_own_instant_is_read_either_way_a_store_writes_it() {
        let any = declare(vec![present("type")], &["type"], TailLane::Usage);
        let watches = std::slice::from_ref(&any);
        assert_eq!(
            carried(TOKEN_COUNT_LINE.as_bytes(), watches)
                .unwrap()
                .source_at,
            Some(SourceTimestamp::Iso(SOURCE_ISO.into()))
        );
        assert_eq!(
            carried(USAGE_RECORD_LINE.as_bytes(), watches)
                .unwrap()
                .source_at,
            Some(SourceTimestamp::UnixMillis(1_784_800_000_000))
        );
        // Nothing to say is not a failure — the file's mtime stands in,
        // which `reader` supplies.
        assert_eq!(
            carried(br#"{"type":"x"}"#, watches).unwrap().source_at,
            None
        );
        assert_eq!(carried(b"not json", watches), None);
    }

    #[test]
    fn catch_up_keeps_the_last_of_each_watch_in_declaration_order() {
        // Declaration order is the catch-up order: the watch carrying the
        // model and window is declared FIRST, so it lands before the counts
        // it qualifies.
        let context = declare(
            vec![equals("type", "turn_context")],
            &["type"],
            TailLane::Usage,
        );
        let counts = declare(
            vec![equals("payload.type", "token_count")],
            &["payload"],
            TailLane::Usage,
        );
        let watches = vec![context, counts];
        let mut folds = Folds::default();

        let old = watched_event(TURN_CONTEXT_LINE.as_bytes(), &watches, &mut folds).unwrap();
        let mut newer = old.clone();
        newer.payload["record"]["type"] = "turn_context_newer".into();
        let count = watched_event(TOKEN_COUNT_LINE.as_bytes(), &watches, &mut folds).unwrap();

        let kept = last_of_each(vec![old, count.clone(), newer.clone()], &watches);
        assert_eq!(kept, vec![newer, count]);
        assert!(last_of_each(Vec::new(), &watches).is_empty());
    }

    #[test]
    fn catch_up_never_replays_a_status_record() {
        // A record read out of the EXISTING file describes a turn that ended
        // before this deck was looking. It does not survive the collapse at
        // all — the lane its dialect declared is the whole of the rule.
        let marker = declare(
            vec![present("interruptedMessageId")],
            &["interruptedMessageId"],
            TailLane::Status,
        );
        let watches = std::slice::from_ref(&marker);
        let event = carried(br#"{"interruptedMessageId":"msg-7"}"#, watches).unwrap();
        assert!(last_of_each(vec![event], watches).is_empty());
    }
}
