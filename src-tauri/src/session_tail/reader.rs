//! Incremental byte reader for one followed file: offset + carried partial
//! line, fixed-size chunks, bounded buffering. Knows nothing about panes,
//! threads or Tauri — bytes in, dialect events out.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use serde_json::Value;

use super::dialects::{watched_events, SourceRef, SourceTimestamp, TailWatch, TailedEvent};

#[derive(Default)]
pub(super) struct TailCursor {
    pub(super) offset: u64,
    pub(super) partial: Vec<u8>,
    /// Inside an abandoned oversized line — drop bytes until its newline.
    pub(super) skipping: bool,
    /// The latest `calls` context record read out of THIS file — what the
    /// calls after it ran on. Per file: a subagent's transcript names its
    /// own model, and a rewritten file starts over without one.
    pub(super) context: Option<Value>,
    /// (dev, ino) of the file last drained — a same-path REPLACEMENT (the
    /// CLI rewrote the transcript via rename) changes it even when the new
    /// file is longer than the old offset, which the shrink test alone
    /// reads as plain appends and then delivers history as live.
    identity: Option<(u64, u64)>,
}

#[cfg(unix)]
fn file_identity(metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_identity(_metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

/// A pathological line (megabytes with no newline yet) must not buffer
/// forever — past this cap the line is abandoned and the tail resyncs at
/// the next newline. Generous: real usage lines are a few KB.
const MAX_PARTIAL_BYTES: usize = 8 * 1024 * 1024;

/// Read appended bytes in fixed-size chunks, returning events from complete
/// lines while carrying at most one bounded partial line. No prefix is ever
/// drained from a Vec, so catch-up remains linear even for large transcripts.
/// The bool reports a truncated/rotated file.
///
/// `watches` is the dialect's own declaration of which records to carry out
/// of the store. An empty watch list carries nothing: there are no arms of
/// our own left to fall back on.
///
/// `root` says whether this file IS the session or merely contributes to it
/// (a claude subagent transcript): a carried record's `root` mark.
pub(super) fn drain_file(
    path: &std::path::Path,
    cursor: &mut TailCursor,
    watches: &[TailWatch],
    root: bool,
) -> (Vec<TailedEvent>, bool) {
    let Ok(mut file) = File::open(path) else {
        return (Vec::new(), false);
    };
    // A transient stat failure must not TOUCH the cursor: `len` defaulting
    // to 0 would fake a shrink, reset the offset, and the next successful
    // poll would re-read the whole file as LIVE appends (the rotated flag
    // having been consumed by this tick's empty batch) — history delivered
    // as fresh events, the exact corruption rotation detection exists to
    // stop. Skip the tick; the next one resumes from the same offset.
    let Ok(metadata) = file.metadata() else {
        return (Vec::new(), false);
    };
    let len = metadata.len();
    let file_mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);
    // Rotation = the file shrank OR it is a different file at the same
    // path (dev/ino changed under an unchanged-or-longer length).
    let identity = file_identity(&metadata);
    let replaced = matches!((cursor.identity, identity), (Some(a), Some(b)) if a != b);
    let rotated = replaced || len < cursor.offset;
    if rotated {
        cursor.offset = 0;
        cursor.partial.clear();
        cursor.skipping = false;
        // A rewritten file has said nothing yet about what its calls run on.
        cursor.context = None;
    }
    if identity.is_some() {
        cursor.identity = identity;
    }
    if len == cursor.offset || file.seek(SeekFrom::Start(cursor.offset)).is_err() {
        return (Vec::new(), rotated);
    }

    let mut events = Vec::new();
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        match file.read(&mut chunk) {
            // A signal-interrupted read is not EOF: treating it as one
            // would end this drain mid-file and deliver the remainder next
            // poll as if it were fresh appends.
            Err(ref error) if error.kind() == std::io::ErrorKind::Interrupted => {
                continue;
            }
            Err(_) | Ok(0) => break,
            Ok(read) => {
                let base = cursor.offset;
                cursor.offset += read as u64;
                parse_chunk(
                    cursor,
                    &chunk[..read],
                    base,
                    watches,
                    Provenance {
                        file_mtime_ms,
                        root,
                        file: path.to_string_lossy().as_ref(),
                    },
                    &mut events,
                );
            }
        }
    }
    (events, rotated)
}

/// What this FILE lends every record read out of it: its mtime, as the
/// fallback for a record that stamps no time of its own, whether it is the
/// session's own file or a contributor to it, and its path — a call's place.
#[derive(Clone, Copy)]
struct Provenance<'a> {
    file_mtime_ms: Option<u64>,
    root: bool,
    file: &'a str,
}

/// One chunk, read from byte `base` of the file.
fn parse_chunk(
    cursor: &mut TailCursor,
    chunk: &[u8],
    base: u64,
    watches: &[TailWatch],
    from: Provenance<'_>,
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

    let mut context = cursor.context.take();
    while let Some(relative_nl) = chunk[start..].iter().position(|byte| *byte == b'\n') {
        let nl = start + relative_nl;
        let fragment = &chunk[start..nl];
        // Where the line began: in this chunk, or — for a line carried over
        // from earlier chunks — as far back as the part already held.
        let line_at = (base + start as u64).saturating_sub(cursor.partial.len() as u64);
        if cursor.partial.len() + fragment.len() <= MAX_PARTIAL_BYTES {
            if cursor.partial.is_empty() {
                push_event(watches, &mut context, fragment, from, line_at, events);
            } else {
                cursor.partial.extend_from_slice(fragment);
                push_event(watches, &mut context, &cursor.partial, from, line_at, events);
                cursor.partial.clear();
            }
        } else {
            cursor.partial.clear();
        }
        start = nl + 1;
    }
    cursor.context = context;

    let remainder = &chunk[start..];
    if cursor.partial.len() + remainder.len() > MAX_PARTIAL_BYTES {
        cursor.partial.clear();
        cursor.skipping = true;
    } else {
        cursor.partial.extend_from_slice(remainder);
    }
}

fn push_event(
    watches: &[TailWatch],
    context: &mut Option<Value>,
    line: &[u8],
    from: Provenance<'_>,
    line_at: u64,
    events: &mut Vec<TailedEvent>,
) {
    // The dialect's watches are the whole of it now. This used to run them
    // alongside a set of arms of our own, and a line satisfying both
    // travelled twice — once as this side's reading of the numbers, once as
    // the record the other side reads for itself. There is only the second.
    for mut event in watched_events(line, watches, context) {
        event.source_mtime_ms = from.file_mtime_ms;
        if event.source_at.is_none() {
            event.source_at = from.file_mtime_ms.map(SourceTimestamp::UnixMillis);
        }
        // Stamped by the FILE, not by the record: a subagent's abort is the
        // subagent's own story, and no field of the record it was read from
        // could say which transcript it came out of.
        event.root = from.root;
        event.source_ref = Some(SourceRef {
            file: from.file.to_string(),
            offset: line_at,
        });
        events.push(event);
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    use std::io::Write;

    use super::super::dialects::{RecordMatch, TailLane};
    use super::super::test_support::*;
    use super::*;

    /// These tests are about BYTES — torn lines, oversized lines, a file
    /// swapped underneath the cursor — so the watch is the least specific one
    /// that can exist: carry anything with a `type`, keep that and nothing
    /// else. What the records mean is another module's test.
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

    fn drain(path: &std::path::Path, cursor: &mut TailCursor) -> Vec<TailedEvent> {
        drain_file(path, cursor, &any_typed_record(), true).0
    }

    // A call's place in its store is the byte its line starts at — also for
    // a line torn across two reads.
    #[test]
    fn every_record_knows_the_byte_its_line_starts_at() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let first = format!("{TURN_CONTEXT_LINE}\n");
        let (head, rest) = TOKEN_COUNT_LINE.split_at(40);
        fs::write(&path, format!("{first}{head}")).unwrap();
        let mut cursor = TailCursor::default();
        let events = drain(&path, &mut cursor);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].source_ref.as_ref().map(|r| r.offset), Some(0));
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{rest}").unwrap();
        let events = drain(&path, &mut cursor);
        assert_eq!(events[0].source_ref.as_ref().map(|r| r.offset), Some(first.len() as u64));
        assert_eq!(
            events[0].source_ref.as_ref().map(|r| r.file.clone()),
            Some(path.to_string_lossy().into_owned())
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn drain_reads_incrementally_and_carries_torn_lines() {
        let dir = temp_dir();
        let path = dir.join("rollout.jsonl");
        let mut cursor = TailCursor::default();

        // Nothing yet — the file doesn't even exist.
        assert!(drain(&path, &mut cursor).is_empty());

        // A torn write: half a line, no newline — nothing to parse, carried.
        let (head, rest) = TOKEN_COUNT_LINE.split_at(50);
        fs::write(&path, head).unwrap();
        assert!(drain(&path, &mut cursor).is_empty());

        // The rest lands (plus a full second line): both parse now.
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{rest}\n{TURN_CONTEXT_LINE}\n").unwrap();
        drop(file);
        let events = drain(&path, &mut cursor);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].payload["record"]["type"], "event_msg");
        assert_eq!(events[1].payload["record"]["type"], "turn_context");

        // Already consumed — nothing new.
        assert!(drain(&path, &mut cursor).is_empty());

        // A shrunk file (rotation) restarts from zero instead of misreading.
        fs::write(&path, format!("{TURN_CONTEXT_LINE}\n")).unwrap();
        let events = drain(&path, &mut cursor);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["record"]["type"], "turn_context");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_oversized_line_is_abandoned_and_the_tail_resyncs() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let mut cursor = TailCursor::default();

        // A monster line spilling past the cap, no newline yet.
        fs::write(&path, vec![b'x'; MAX_PARTIAL_BYTES + 64]).unwrap();
        assert!(drain(&path, &mut cursor).is_empty());
        assert!(cursor.skipping, "the line is abandoned, not buffered");
        assert!(cursor.partial.is_empty());

        // Its newline finally lands, followed by a healthy line — the tail
        // resyncs and parses only the healthy one.
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "tail-of-monster\n{TURN_CONTEXT_LINE}\n").unwrap();
        drop(file);
        let events = drain(&path, &mut cursor);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["record"]["type"], "turn_context");
        assert!(!cursor.skipping);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_rotation_while_skipping_keeps_the_new_files_first_line() {
        let dir = temp_dir();
        let path = dir.join("wire.jsonl");
        let mut cursor = TailCursor::default();

        // Monster line puts the tail into skip mode…
        fs::write(&path, vec![b'x'; MAX_PARTIAL_BYTES + 64]).unwrap();
        assert!(drain(&path, &mut cursor).is_empty());
        assert!(cursor.skipping);

        // …then the file is ROTATED before the monster's newline arrives.
        // The fresh file's first line must parse, not vanish as the
        // monster's imagined tail.
        fs::write(&path, format!("{TURN_CONTEXT_LINE}\n")).unwrap();
        let events = drain(&path, &mut cursor);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["record"]["type"], "turn_context");
        assert!(!cursor.skipping);

        fs::remove_dir_all(&dir).ok();
    }

    // Rotation must also catch a rename-replacement whose new file is at
    // least as long as the old offset — the shrink test alone reads its
    // tail as appends and delivers history as live.
    #[test]
    fn a_same_path_replacement_rotates_even_when_longer() {
        let dir = temp_dir();
        let path = dir.join("rollout-swap.jsonl");
        let mut cursor = TailCursor::default();
        fs::write(&path, format!("{TURN_CONTEXT_LINE}\n")).unwrap();
        let watches = any_typed_record();
        let (events, rotated) = drain_file(&path, &mut cursor, &watches, true);
        assert_eq!(events.len(), 1);
        assert!(!rotated);

        let staged = dir.join("rollout-swap.jsonl.staged");
        fs::write(
            &staged,
            format!("{TURN_CONTEXT_LINE}\n{TOKEN_COUNT_LINE}\n{TURN_CONTEXT_LINE}\n"),
        )
        .unwrap();
        fs::rename(&staged, &path).unwrap();
        let (events, rotated) = drain_file(&path, &mut cursor, &watches, true);
        assert_eq!(events.len(), 3, "the whole new file re-reads from zero");
        assert!(rotated, "a different inode at the same path is a rotation");
        fs::remove_dir_all(&dir).ok();
    }
}
