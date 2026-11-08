//! The three session-file dialects: which lines matter, what event each
//! becomes, and the catch-up policy over those events. Pure parsing — no
//! files, no threads, no Tauri.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

// A `TailFormat` enum stood here — Claude, Codex, KimiWire — and each
// variant owned a line filter, a catch-up order and a set of parse arms.
// That is how three CLIs' formats came to live in the side meant to know
// none of them. The last two things it was still good for are gone with it:
// the `agent` tag a report rides under is passed at arming by the side that
// knows the pane, and the shape of a store is described by the plugin whose
// store it is. Nothing in this module names an agent now.

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
    /// Latest cold metadata may seed the decoder, never publish activity.
    #[serde(default)]
    pub replay_context: bool,
    /// A `calls` record that is no call but qualifies the calls after it in
    /// its file: held, not carried, and attached to every later `calls`
    /// record of the same file as its `context`.
    #[serde(default)]
    pub context: bool,
    /// A `calls` record naming another store of the same session: carried
    /// whole on a re-read, not from `since`.
    #[serde(default)]
    pub links: bool,
}

/// The three questions a session store answers. This side does not know
/// which one any record answers; it forwards what it was told.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TailLane {
    Status,
    Usage,
    /// Each record a call: carried EVERY time, never collapsed into the last
    /// of a run, and on a re-read only from `since`.
    Calls,
}

impl TailLane {
    fn wire(self) -> &'static str {
        match self {
            TailLane::Status => "status",
            TailLane::Usage => "usage",
            TailLane::Calls => "calls",
        }
    }
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
///
/// `context` is the file's latest `calls` context record: a context watch
/// replaces it and carries nothing, and every `calls` record carried after
/// it travels with a copy.
pub(super) fn watched_events(
    line: &[u8],
    watches: &[TailWatch],
    context: &mut Option<Value>,
) -> Vec<TailedEvent> {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return Vec::new();
    };
    if !value.is_object() {
        return Vec::new();
    }
    // First match PER LANE: a context record can describe both execution
    // mode and usage. Parse its bytes once, retain each lane's projection.
    let mut lanes = Vec::new();
    let mut events = Vec::new();
    for (slot, watch) in watches.iter().enumerate() {
        if lanes.contains(&watch.lane) {
            continue;
        }
        let Some(kept) = kept_fields(&value, watch) else {
            continue;
        };
        lanes.push(watch.lane);
        if watch.lane == TailLane::Calls && watch.context {
            *context = Some(Value::Object(kept));
            continue;
        }
        events.push(carry(&value, watch, slot, kept, context.as_ref()));
    }
    events
}

/// The fields `watch` names, when `value` satisfies every clause of it.
fn kept_fields(value: &Value, watch: &TailWatch) -> Option<serde_json::Map<String, Value>> {
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
    Some(kept)
}

fn carry(
    value: &Value,
    watch: &TailWatch,
    slot: usize,
    kept: serde_json::Map<String, Value>,
    context: Option<&Value>,
) -> TailedEvent {
    let mut payload = json!({
        "type": CARRIED_RECORD,
        "record": Value::Object(kept),
        "replayContext": watch.replay_context,
        "lane": watch.lane.wire(),
    });
    if watch.lane == TailLane::Calls {
        if let Some(context) = context {
            payload["context"] = context.clone();
        }
    }
    TailedEvent {
        payload,
        // Provenance stays this side's job: the freshness guard is about the
        // deck's clock against the store's, which is a fact about following
        // a file rather than about any agent's format.
        source_at: source_timestamp(value),
        source_mtime_ms: None,
        source_ref: None,
        root: true,
        slot: Some(slot),
        links: watch.links,
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

impl SourceTimestamp {
    /// This instant in unix milliseconds — None for an ISO text that is not
    /// one. Only what `since` needs: a filter on records far older than it.
    pub(super) fn unix_ms(&self) -> Option<f64> {
        match self {
            SourceTimestamp::UnixMillis(ms) => Some(*ms as f64),
            SourceTimestamp::Iso(text) => iso_unix_ms(text),
        }
    }
}

/// An RFC 3339 instant (`2026-11-01T20:34:10.756Z`, an offset instead of
/// `Z` allowed) in unix milliseconds.
fn iso_unix_ms(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let number = |from: usize, to: usize| -> Option<i64> { text.get(from..to)?.parse().ok() };
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || !matches!(bytes[10], b'T' | b't' | b' ') {
        return None;
    }
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    let mut rest = &text[19..];
    let mut millis = 0.0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        millis = format!("0.{}", &fraction[..digits]).parse::<f64>().ok()? * 1000.0;
        rest = &fraction[digits..];
    }
    let offset_minutes = match rest {
        "Z" | "z" => 0,
        _ if rest.len() == 6 && matches!(rest.as_bytes()[0], b'+' | b'-') => {
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            sign * (rest.get(1..3)?.parse::<i64>().ok()? * 60 + rest.get(4..6)?.parse::<i64>().ok()?)
        }
        _ => return None,
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds as f64 * 1000.0 + millis)
}

/// Where a carried record sits in its store: the file and the byte offset
/// of its line. An agent whose store gives a call no id of its own takes
/// this as one — stable for as long as the file is.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(super) struct SourceRef {
    pub(super) file: String,
    pub(super) offset: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct TailedEvent {
    pub(super) payload: Value,
    pub(super) source_at: Option<SourceTimestamp>,
    pub(super) source_mtime_ms: Option<u64>,
    /// Where the record sits, for a `calls` record.
    pub(super) source_ref: Option<SourceRef>,
    /// From the session's ROOT file (false = a claude subagent transcript).
    /// An interrupt marker is pane-level only when the ROOT turn was
    /// aborted; a subagent's own abort must not relabel the pane.
    pub(super) root: bool,
    /// Which watch carried this record — the only thing catch-up can
    /// collapse on, now that every carried record travels under one type.
    /// `None` for events this side minted itself.
    pub(super) slot: Option<usize>,
    /// Carried by a `links` watch: a re-read keeps it whatever its age.
    pub(super) links: bool,
}

impl TailedEvent {
    fn is_call(&self) -> bool {
        self.payload["lane"] == TailLane::Calls.wire()
    }
}

// The three parse arms stood here: which claude transcript lines carried
// usage and what to trim them to, which codex rollout payloads were worth
// forwarding, which kimi wire records were small enough to ride verbatim.
// Every one of them was a statement about somebody else's format, made by
// the side that reads the bytes. They are declarations now — a watch names
// the records and the fields — and this file compares keys and copies values
// without knowing whose store it is in.

/// How deep under a sibling directory files are looked for: claude nests a
/// workflow's agents one level down (`subagents/workflows/<run>/`), kimi a
/// subagent's wire in a directory of its own (`agents/<id>/wire.jsonl`).
const SIBLING_DEPTH: usize = 3;

/// The `.jsonl` files in a directory the followed store's own dialect named
/// as contributing to the SAME session, and in the directories under it.
///
/// Read every poll rather than once, because the files appear as the work
/// that writes them starts — long after the tail was armed. Which directory
/// is not asked here: the rule that turns a transcript's path into its
/// siblings' is the agent's, and it arrives already applied.
pub(super) fn sibling_paths(directory: &Path) -> Vec<PathBuf> {
    fn walk(directory: &Path, depth: usize, into: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() && depth > 0 {
                walk(&path, depth - 1, into);
            } else if kind.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                into.push(path);
            }
        }
    }
    let mut paths = Vec::new();
    walk(directory, SIBLING_DEPTH, &mut paths);
    paths.sort();
    paths
}

/// The `calls` records a read keeps: those at or after `since` (unix ms), and
/// every `links` record whatever its age — a subagent spawned long ago may
/// still be running, and its file is found only through the record that
/// named it. A record that states no time is kept: whether it counts is the
/// ledger's to decide, by the call's own time.
pub(super) fn calls_since(events: Vec<TailedEvent>, since: Option<f64>) -> Vec<TailedEvent> {
    events
        .into_iter()
        .filter(|event| event.is_call())
        .filter(|event| {
            event.links
                || since.is_none_or(|since| {
                    event
                        .source_at
                        .as_ref()
                        .and_then(SourceTimestamp::unix_ms)
                        .is_none_or(|at| at >= since)
                })
        })
        .collect()
}

/// The status half of a catch-up: of the ROOT file's status-lane records,
/// the last of each watch, in FILE order — what a reconcile reads to tell
/// whether the latest turn the file records has ended. Context-only
/// metadata is not here (`last_of_each` keeps it), nor is a subagent file's
/// status: its turns are its own story.
///
/// File order, not watch order, because the question a reader asks of it is
/// "did anything start after the last ending" — which only the order the
/// records were written in can answer.
pub(super) fn last_status_of_each(events: &[TailedEvent], watches: &[TailWatch]) -> Vec<TailedEvent> {
    let mut last: Vec<Option<(usize, &TailedEvent)>> = (0..watches.len()).map(|_| None).collect();
    for (position, event) in events.iter().enumerate() {
        let Some(slot) = event.slot else { continue };
        let Some(watch) = watches.get(slot) else {
            continue;
        };
        if !event.root || watch.lane != TailLane::Status || watch.replay_context {
            continue;
        }
        last[slot] = Some((position, event));
    }
    let mut kept: Vec<(usize, &TailedEvent)> = last.into_iter().flatten().collect();
    kept.sort_by_key(|(position, _)| *position);
    kept.into_iter().map(|(_, event)| event.clone()).collect()
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
/// Status-lane activity records are not part of this summary: they leave as
/// a reconcile ([`last_status_of_each`]), which the tracker may use only to
/// END a turn still shown as running — never to start one. Explicit
/// context-only metadata keeps its latest value to seed the decoder.
pub(super) fn last_of_each(events: Vec<TailedEvent>, watches: &[TailWatch]) -> Vec<TailedEvent> {
    let mut last: Vec<Option<TailedEvent>> = (0..watches.len()).map(|_| None).collect();
    for event in events {
        let Some(slot) = event.slot else { continue };
        let Some(watch) = watches.get(slot) else {
            continue;
        };
        // A status edge leaves as a reconcile; a call is never summarised
        // away — every one of them is a call ([`calls_since`]).
        if (watch.lane == TailLane::Status && !watch.replay_context) || watch.lane == TailLane::Calls {
            continue;
        }
        last[slot] = Some(event);
    }
    last.into_iter().flatten().collect()
}

/// A live tick's records, each unbroken run of one usage watch collapsed to
/// its last record.
///
/// A store can write one message as several lines — a claude transcript
/// writes each content block of an assistant message as a line of its own,
/// restating the message's usage — and every line was delivered, to be
/// normalized, merged and booked in turn. The next record of the same usage
/// watch supersedes the one before it: a summed watch stamps the running
/// total on each, and every other usage record states the latest reading.
///
/// Only a run is collapsed. A record of any other watch between two keeps
/// both, so no record moves past one that qualifies it: a model switch
/// between two turns still lands between them. A run does not cross from
/// the root file into a subagent's, status records are never collapsed (each
/// is an edge of its own), and neither is anything this side minted.
pub(super) fn drop_superseded(events: Vec<TailedEvent>, watches: &[TailWatch]) -> Vec<TailedEvent> {
    let usage_slot = |event: &TailedEvent| {
        event.slot.filter(|slot| {
            watches
                .get(*slot)
                .is_some_and(|watch| watch.lane == TailLane::Usage)
        })
    };
    let mut kept: Vec<TailedEvent> = Vec::with_capacity(events.len());
    for event in events {
        let superseded = kept.last().is_some_and(|previous| {
            usage_slot(&event).is_some()
                && usage_slot(previous) == usage_slot(&event)
                && previous.root == event.root
        });
        if superseded {
            kept.pop();
        }
        kept.push(event);
    }
    kept
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
            replay_context: false,
            context: false,
            links: false,
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
        watched_events(line, watches, &mut None)
            .into_iter()
            .next()
    }

    // A reconcile reads "did anything start after the last ending": it keeps
    // the last record of each ROOT status watch, in the order the file wrote
    // them — not context metadata, not usage, not a subagent's own turns.
    #[test]
    fn the_status_summary_is_the_last_of_each_root_watch_in_file_order() {
        let mut context = declare(vec![equals("type", "mode")], &["type", "n"], TailLane::Status);
        context.replay_context = true;
        let watches = vec![
            declare(vec![equals("type", "start")], &["type", "n"], TailLane::Status),
            declare(vec![equals("type", "end")], &["type", "n"], TailLane::Status),
            declare(vec![equals("type", "usage")], &["type", "n"], TailLane::Usage),
            context,
        ];
        let lines: [&[u8]; 6] = [
            br#"{"type":"end","n":1}"#,
            br#"{"type":"start","n":2}"#,
            br#"{"type":"mode","n":3}"#,
            br#"{"type":"usage","n":4}"#,
            br#"{"type":"end","n":5}"#,
            br#"{"type":"start","n":6}"#,
        ];
        let mut events: Vec<TailedEvent> = lines.iter().filter_map(|line| carried(line, &watches)).collect();
        let mut child = present_in_child(&watches);
        events.push(child.take().unwrap());
        let kept: Vec<i64> = last_status_of_each(&events, &watches)
            .iter()
            .map(|event| event.payload["record"]["n"].as_i64().unwrap())
            .collect();
        assert_eq!(kept, vec![5, 6], "end 5 before start 6, as written");
    }

    // One message written as several lines is one report: each unbroken run
    // of a usage watch keeps its last record, and nothing moves past another.
    #[test]
    fn a_live_tick_keeps_the_last_of_each_run_of_a_usage_watch() {
        let watch =
            |kind: &str, lane: TailLane| declare(vec![equals("type", kind)], &["type", "n"], lane);
        let watches = vec![
            watch("model", TailLane::Usage),
            watch("usage", TailLane::Usage),
            watch("end", TailLane::Status),
        ];
        let lines: [&[u8]; 9] = [
            br#"{"type":"usage","n":1}"#,
            br#"{"type":"usage","n":2}"#,
            br#"{"type":"usage","n":3}"#,
            br#"{"type":"end","n":4}"#,
            br#"{"type":"end","n":5}"#,
            br#"{"type":"usage","n":6}"#,
            br#"{"type":"model","n":7}"#,
            br#"{"type":"usage","n":8}"#,
            br#"{"type":"usage","n":9}"#,
        ];
        let mut events: Vec<TailedEvent> = lines
            .iter()
            .filter_map(|line| carried(line, &watches))
            .collect();
        // A subagent's record never folds into the root's run before it.
        let mut child = carried(br#"{"type":"usage","n":10}"#, &watches).unwrap();
        child.root = false;
        events.push(child);
        let kept: Vec<i64> = drop_superseded(events, &watches)
            .iter()
            .map(|event| event.payload["record"]["n"].as_i64().unwrap())
            .collect();
        assert_eq!(kept, vec![3, 4, 5, 6, 7, 9, 10]);
    }

    /// A status record from a subagent file — which a reconcile must skip.
    fn present_in_child(watches: &[TailWatch]) -> Option<TailedEvent> {
        let mut event = carried(br#"{"type":"end","n":7}"#, watches)?;
        event.root = false;
        Some(event)
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

    fn calls(clauses: Vec<RecordMatch>, keep: &[&str]) -> TailWatch {
        declare(clauses, keep, TailLane::Calls)
    }

    // A context record qualifies the calls after it in its file: it is held,
    // never carried, and every later call travels with its fields.
    #[test]
    fn a_context_record_is_held_and_attached_to_the_calls_after_it() {
        let mut context_watch = calls(vec![equals("type", "turn_context")], &["payload.model"]);
        context_watch.context = true;
        let call_watch = calls(vec![equals("payload.type", "token_count")], &["payload.type"]);
        let watches = vec![context_watch, call_watch];
        let mut context = None;

        let before = watched_events(TOKEN_COUNT_LINE.as_bytes(), &watches, &mut context);
        assert_eq!(before.len(), 1);
        assert!(before[0].payload.get("context").is_none(), "no context seen yet");

        let held = watched_events(TURN_CONTEXT_LINE.as_bytes(), &watches, &mut context);
        assert!(held.is_empty(), "a context record is not itself carried");
        assert!(context.is_some());

        let after = watched_events(TOKEN_COUNT_LINE.as_bytes(), &watches, &mut context);
        assert_eq!(after[0].payload["lane"], "calls");
        assert!(after[0].payload["context"]["payload.model"].is_string(), "{:?}", after[0].payload);
    }

    #[test]
    fn a_watch_reads_the_plugins_camel_case_wire() {
        let watch: TailWatch = serde_json::from_str(
            r#"{"match":[{"key":"type","equals":"turn_context"}],"keep":["payload.model"],
                "lane":"calls","context":true}"#,
        )
        .expect("the wire a plugin declares");
        assert_eq!(watch.lane, TailLane::Calls);
        assert!(watch.context && !watch.links);
    }

    fn call_at(at: Option<SourceTimestamp>, links: bool) -> TailedEvent {
        TailedEvent {
            payload: json!({ "type": CARRIED_RECORD, "record": {}, "lane": "calls" }),
            source_at: at,
            source_mtime_ms: None,
            source_ref: None,
            root: true,
            slot: Some(0),
            links,
        }
    }

    // A re-read keeps the calls at or after `since`, every links record, and
    // a call that states no time; it keeps nothing of another lane.
    #[test]
    fn a_re_read_keeps_calls_from_since_and_every_link() {
        let old = call_at(Some(SourceTimestamp::UnixMillis(1_000)), false);
        let new = call_at(Some(SourceTimestamp::Iso("1970-01-01T00:00:05.000Z".into())), false);
        let old_link = call_at(Some(SourceTimestamp::UnixMillis(1_000)), true);
        let timeless = call_at(None, false);
        let mut usage = call_at(Some(SourceTimestamp::UnixMillis(9_000)), false);
        usage.payload["lane"] = "usage".into();
        let kept = calls_since(vec![old.clone(), new.clone(), old_link.clone(), timeless.clone(), usage], Some(5_000.0));
        assert_eq!(kept, vec![new.clone(), old_link, timeless]);
        assert_eq!(calls_since(vec![old.clone(), new.clone()], None), vec![old, new]);
    }

    #[test]
    fn a_catch_up_summary_never_takes_a_call() {
        let watches = vec![calls(vec![present("type")], &["type"])];
        assert!(last_of_each(vec![call_at(None, false)], &watches).is_empty());
    }

    #[test]
    fn an_rfc_3339_instant_reads_as_unix_milliseconds() {
        assert_eq!(iso_unix_ms("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(iso_unix_ms("2026-11-01T20:34:10.756Z"), Some(1_793_565_250_756.0));
        assert_eq!(iso_unix_ms("2026-11-01T21:34:10.756+01:00"), Some(1_793_565_250_756.0));
        assert_eq!(iso_unix_ms("2000-02-29T12:00:00Z"), Some(951_825_600_000.0));
        assert_eq!(iso_unix_ms("not a time"), None);
        assert_eq!(iso_unix_ms("2026-11-01T20:34:10"), None, "no zone, no instant");
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
        let mut held = None;

        let old = watched_events(TURN_CONTEXT_LINE.as_bytes(), &watches, &mut held)
            .into_iter()
            .next()
            .unwrap();
        let mut newer = old.clone();
        newer.payload["record"]["type"] = "turn_context_newer".into();
        let count = watched_events(TOKEN_COUNT_LINE.as_bytes(), &watches, &mut held)
            .into_iter()
            .next()
            .unwrap();

        let kept = last_of_each(vec![old, count.clone(), newer.clone()], &watches);
        assert_eq!(kept, vec![newer, count]);
        assert!(last_of_each(Vec::new(), &watches).is_empty());
    }

    /// The other side of the conformance corpus.
    ///
    /// A watch is WRITTEN in TypeScript and APPLIED here. The types are a
    /// wire contract and cannot be merged, but the SEMANTICS can drift —
    /// one side quietly growing a trim, a coercion or a looser notion of
    /// presence while the other never hears of it, and the same watch then
    /// carrying different records depending on who read it. Nothing but this
    /// file binds the two.
    ///
    /// `include_str!` on purpose: a corpus that moved or vanished is a build
    /// failure, not a suite that quietly runs zero cases. Its first run
    /// already earned its keep — the two path walkers disagreed about
    /// arrays, and the plugin side was wrong.
    #[test]
    fn both_readers_agree_on_the_descriptor_language() {
        #[derive(serde::Deserialize)]
        struct Carried {
            watch: usize,
            record: Value,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            watches: Vec<TailWatch>,
            record: Value,
            carried: Option<Carried>,
        }
        #[derive(serde::Deserialize)]
        struct Corpus {
            cases: Vec<Case>,
        }

        let corpus: Corpus = serde_json::from_str(include_str!(
            "../../../packages/plugin-api/conformance/watch-cases.json"
        ))
        .expect("the shared corpus parses");
        assert!(
            corpus.cases.len() > 15,
            "a corpus that silently emptied lets both sides pass while agreeing on nothing"
        );

        for case in corpus.cases {
            let line = serde_json::to_vec(&case.record).unwrap();
            let carried = watched_events(&line, &case.watches, &mut None)
                .into_iter()
                .next();
            match (carried, case.carried) {
                (None, None) => {}
                (Some(event), Some(want)) => {
                    assert_eq!(event.slot, Some(want.watch), "{}", case.name);
                    assert_eq!(event.payload["record"], want.record, "{}", case.name);
                }
                (Some(event), None) => {
                    panic!(
                        "{}: carried {} when nothing should be",
                        case.name, event.payload
                    )
                }
                (None, Some(_)) => panic!("{}: carried nothing", case.name),
            }
        }
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
