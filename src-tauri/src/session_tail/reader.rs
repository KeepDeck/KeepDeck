//! Incremental byte reader for one followed file: offset + carried partial
//! line, fixed-size chunks, bounded buffering. Knows nothing about panes,
//! threads or Tauri — bytes in, dialect events out.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use super::dialects::{SourceTimestamp, TailFormat, TailedEvent};

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
pub(super) const MAX_PARTIAL_BYTES: usize = 8 * 1024 * 1024;

/// Read appended bytes in fixed-size chunks, returning events from complete
/// lines while carrying at most one bounded partial line. No prefix is ever
/// drained from a Vec, so catch-up remains linear even for large transcripts.
/// The bool reports a truncated/rotated file.
pub(super) fn drain_file(
    path: &std::path::Path,
    cursor: &mut TailCursor,
    format: TailFormat,
) -> (Vec<TailedEvent>, bool) {
    let Ok(mut file) = File::open(path) else {
        return (Vec::new(), false);
    };
    let metadata = file.metadata().ok();
    let len = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
    let file_mtime_ms = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);
    // Rotation = the file shrank OR it is a different file at the same
    // path. A transient stat failure keeps the last identity rather than
    // wiping it — the next successful stat still detects the swap.
    let identity = metadata.as_ref().and_then(file_identity);
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
                parse_chunk(cursor, &chunk[..read], format, file_mtime_ms, &mut events);
            }
        }
    }
    (events, rotated)
}

pub(super) fn parse_chunk(
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

pub(super) fn push_event(
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
