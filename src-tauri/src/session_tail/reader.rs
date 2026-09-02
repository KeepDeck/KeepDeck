//! Incremental byte reader for one followed file: offset + carried partial
//! line, fixed-size chunks, bounded buffering. Knows nothing about panes,
//! threads or Tauri — bytes in, dialect events out.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use super::dialects::{watched_event, SourceTimestamp, TailFormat, TailWatch, TailedEvent};

#[derive(Default)]
pub(super) struct TailCursor {
    pub(super) offset: u64,
    pub(super) partial: Vec<u8>,
    /// Inside an abandoned oversized line — drop bytes until its newline.
    pub(super) skipping: bool,
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
/// `watch` is the dialect's own declaration of which records to carry out of
/// the store. `None` means nothing is carried and only the format's own arms
/// run — the state of every tail whose plugin has not moved over yet.
pub(super) fn drain_file(
    path: &std::path::Path,
    cursor: &mut TailCursor,
    format: TailFormat,
    watches: &[TailWatch],
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
    let replaced =
        matches!((cursor.identity, identity), (Some(a), Some(b)) if a != b);
    let rotated = replaced || len < cursor.offset;
    if rotated {
        cursor.offset = 0;
        cursor.partial.clear();
        cursor.skipping = false;
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
                cursor.offset += read as u64;
                parse_chunk(cursor, &chunk[..read], format, watches, file_mtime_ms, &mut events);
            }
        }
    }
    (events, rotated)
}

fn parse_chunk(
    cursor: &mut TailCursor,
    chunk: &[u8],
    format: TailFormat,
    watches: &[TailWatch],
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
                push_event(format, watches, fragment, file_mtime_ms, events);
            } else {
                cursor.partial.extend_from_slice(fragment);
                push_event(format, watches, &cursor.partial, file_mtime_ms, events);
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
    watches: &[TailWatch],
    line: &[u8],
    file_mtime_ms: Option<u64>,
    events: &mut Vec<TailedEvent>,
) {
    // The dialect's own watch runs FIRST and independently of the format's
    // arms: those still extract usage, which has not moved. A line can
    // satisfy both and then travels twice — once as this side's reading of
    // the numbers, once as the record the other side reads for itself.
    let carried = watched_event(line, watches);
    for mut event in carried.into_iter().chain(format.event(line)) {
        event.source_mtime_ms = file_mtime_ms;
        if event.source_at.is_none() {
            event.source_at = file_mtime_ms.map(SourceTimestamp::UnixMillis);
        }
        events.push(event);
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    use std::io::Write;

    use super::super::test_support::*;
    use super::*;

    fn drain(path: &std::path::Path, cursor: &mut TailCursor) -> Vec<TailedEvent> {
        drain_file(path, cursor, TailFormat::Codex, &[]).0
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
        assert_eq!(events[0].payload["type"], "token_count");
        assert_eq!(events[1].payload["type"], "turn_context");

        // Already consumed — nothing new.
        assert!(drain(&path, &mut cursor).is_empty());

        // A shrunk file (rotation) restarts from zero instead of misreading.
        fs::write(&path, format!("{TURN_CONTEXT_LINE}\n")).unwrap();
        let events = drain(&path, &mut cursor);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["type"], "turn_context");

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
        assert_eq!(events[0].payload["type"], "turn_context");
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
        assert_eq!(events[0].payload["type"], "turn_context");
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
        let (events, rotated) = drain_file(&path, &mut cursor, TailFormat::Codex, &[]);
        assert_eq!(events.len(), 1);
        assert!(!rotated);

        let staged = dir.join("rollout-swap.jsonl.staged");
        fs::write(
            &staged,
            format!("{TURN_CONTEXT_LINE}\n{TOKEN_COUNT_LINE}\n{TURN_CONTEXT_LINE}\n"),
        )
        .unwrap();
        fs::rename(&staged, &path).unwrap();
        let (events, rotated) = drain_file(&path, &mut cursor, TailFormat::Codex, &[]);
        assert_eq!(events.len(), 3, "the whole new file re-reads from zero");
        assert!(rotated, "a different inode at the same path is a rotation");
        fs::remove_dir_all(&dir).ok();
    }
}
