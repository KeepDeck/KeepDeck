//! Reading PROJECT files for the plugin `fs` capability.
//!
//! One directory's immediate children ([`project_fs_read_dir`]) and one file's
//! contents ([`project_fs_read_file`]). Both are lazy and non-recursive — a
//! file-tree UI expands a node by asking for that node's children, so a giant
//! `node_modules` never loads until (and unless) someone opens it.
//!
//! The scope boundary these enforce, and the reason it is enforced HERE rather
//! than at the caller, is documented once in the parent module — it binds this
//! half and the watching half identically.

use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom};

use serde::Serialize;

use crate::containment::resolve_within;

/// Default cap for a single [`project_fs_read_file`] read, when the caller
/// names none. A code viewer wants text, not a 2 GB blob paged into the
/// webview, so the common file is read whole and a large one comes back
/// `truncated`.
const DEFAULT_MAX_FILE_BYTES: u64 = 1024 * 1024;

/// Hard ceiling on what a caller may request, so a plugin passing an enormous
/// `maxBytes` can't turn a read into an out-of-memory. Above the default to
/// leave headroom for a legitimately large source file.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// How a zstd frame begins (RFC 8878) — what tells a compressed store from
/// a plain one, file by file, since codex's holds both (task-418).
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
/// The most a frame header takes; its content size sits inside it.
const ZSTD_FRAME_HEADER_MAX: usize = 18;
/// How far into a compressed store a read may reach, counted in its
/// decompressed bytes. Every window decodes from the frame's start, so the
/// offset a plugin names is how much the host decodes for it — bounded here,
/// far past the session reader's 8 MiB, so no honest read meets it.
const INFLATE_REACH: u64 = 64 * 1024 * 1024;
/// The largest window a frame may make the decoder hold: 2^23, 8 MiB.
/// codex writes 2 MiB; a crafted frame asking for gigabytes is refused.
const INFLATE_WINDOW_LOG_MAX: u32 = 23;
/// How much compressed input one read may consume. Padding or skippable
/// frames would otherwise keep a decoder reading while producing nothing.
const INFLATE_INPUT_MAX: u64 = 64 * 1024 * 1024;

/// One directory child, as reported to the plugin. `path` is absolute so the
/// plugin can pass it straight back to read that child (the tree's lazy
/// expansion): no path arithmetic on the plugin side, and containment is
/// re-checked on every call regardless.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub kind: FsKind,
    /// Byte size for a regular file; `None` for a directory or symlink (a
    /// symlink's own size is meaningless to a tree, and it is NOT followed).
    pub size: Option<u64>,
    /// Modification time (epoch ms) for files AND dirs — what incremental
    /// store scans key change detection on. `None` when stat fails.
    pub mtime: Option<i64>,
}

/// What a child is, WITHOUT following symlinks: a symlink is reported as
/// `Symlink`, never silently resolved to whatever it targets. Expanding it
/// later re-canonicalizes, so a symlink escaping the roots is refused then.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FsKind {
    File,
    Dir,
    Symlink,
}

/// One file's contents. Text is decoded UTF-8 (`text: None` when the file is
/// binary — a NUL byte or invalid UTF-8), so the common code-viewer path
/// carries a plain string across the wire rather than a byte array. `size` is
/// the file's FULL length; `truncated` says something remains BEYOND what came
/// back; `read_bytes` says how many bytes this read produced — and how many the
/// TEXT holds, which is the same thing except when the read split a multi-byte
/// character: the dangling stub is dropped and `read_bytes` drops with it, so
/// the number always describes the text actually handed over.
///
/// With an `offset`, `read_bytes` measures the WINDOW, not the file: it counts
/// from `offset`, so `offset + read_bytes` is where the next window starts and
/// `truncated` means "that position is not the end". Anchoring it to the file
/// instead would make every window past the first report a length it did not
/// return, and the incompleteness mark would fire on every chunk of a file
/// being read in full.
///
/// `read_bytes` is REPORTED rather than left for the caller to infer. A caller
/// knows only what it asked for, and the ask is clamped here — so inferring
/// would overstate the read for exactly the callers who asked above the
/// ceiling. The enforcer says what it actually did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsFile {
    pub path: String,
    pub text: Option<String>,
    pub is_binary: bool,
    pub size: u64,
    pub truncated: bool,
    pub read_bytes: u64,
}

/// List one directory's immediate children — non-recursive, one level. The
/// order is NOT specified here (the plugin sorts for display); an entry whose
/// type or name can't be read is skipped rather than failing the whole listing.
#[tauri::command(async)]
pub fn project_fs_read_dir(
    path: String,
    roots: Vec<String>,
    everywhere: bool,
) -> Result<Vec<FsEntry>, String> {
    let dir = resolve_within(&path, &roots, everywhere)?;
    let reader = fs::read_dir(&dir).map_err(|e| format!("cannot read directory: {e}"))?;

    let mut entries = Vec::new();
    for child in reader.flatten() {
        let Ok(file_type) = child.file_type() else {
            continue;
        };
        let metadata = child.metadata().ok();
        let (kind, size) = if file_type.is_symlink() {
            (FsKind::Symlink, None)
        } else if file_type.is_dir() {
            (FsKind::Dir, None)
        } else {
            (FsKind::File, metadata.as_ref().map(|m| m.len()))
        };
        let mtime = metadata
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        entries.push(FsEntry {
            name: child.file_name().to_string_lossy().into_owned(),
            path: child.path().to_string_lossy().into_owned(),
            kind,
            size,
            mtime,
        });
    }
    Ok(entries)
}

/// Read one file's contents, capped. `max_bytes` is the caller's preferred cap,
/// clamped to [`MAX_FILE_BYTES`]; absent, [`DEFAULT_MAX_FILE_BYTES`] applies. A
/// directory target is an error (the plugin should call [`project_fs_read_dir`]).
///
/// `offset` starts the read there instead of at byte zero, which turns the cap
/// from a ceiling on the WHOLE read into the size of one window: a caller that
/// wants a large file entire walks it window by window, holding one window at a
/// time, instead of materializing the file. Where a window may start is the
/// caller's problem — an offset landing inside a multi-byte character produces
/// bytes that are not valid UTF-8 from their first one, and this reports that
/// honestly as binary rather than guessing which bytes to discard. Callers that
/// resume on a boundary they framed themselves (a line, a record) never meet it.
///
/// `inflate` reads a zstd-compressed file as the text it holds: size, offset
/// and window all count its DECOMPRESSED bytes, so a reader walks it as it
/// walks a plain one. A file that is not zstd reads exactly as without it.
/// Opt-in rather than for every read: a code viewer opening a `.zst` should
/// see what is on disk.
#[tauri::command(async)]
pub fn project_fs_read_file(
    path: String,
    roots: Vec<String>,
    everywhere: bool,
    max_bytes: Option<u64>,
    offset: Option<u64>,
    inflate: Option<bool>,
) -> Result<FsFile, String> {
    let file = resolve_within(&path, &roots, everywhere)?;
    let meta = fs::metadata(&file).map_err(|e| format!("cannot stat: {e}"))?;
    if meta.is_dir() {
        return Err(format!("path is a directory: {path}"));
    }
    let size = meta.len();
    let cap = max_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES).min(MAX_FILE_BYTES);

    let start = offset.unwrap_or(0);
    if inflate == Some(true) {
        if let Some(inflated) = read_inflated(&file, start, cap)? {
            return Ok(inflated);
        }
    }
    let mut handle = fs::File::open(&file).map_err(|e| format!("cannot open: {e}"))?;
    if start > 0 {
        handle
            .seek(SeekFrom::Start(start))
            .map_err(|e| format!("cannot seek: {e}"))?;
    }
    let mut buf = Vec::new();
    handle
        .take(cap)
        .read_to_end(&mut buf)
        .map_err(|e| format!("cannot read: {e}"))?;
    let read_bytes = buf.len() as u64;
    // Anything left AFTER this window — the file's end for a read that started
    // at zero, the next window's start for one that did not. A `start` past the
    // end reads nothing and is NOT truncated: there is no remainder to come
    // back for, and saying otherwise would loop a walking reader on emptiness.
    let truncated = size > start.saturating_add(read_bytes);

    let Decoded {
        text,
        is_binary,
        read_bytes,
    } = decode_text(buf, truncated);

    Ok(FsFile {
        path: file.to_string_lossy().into_owned(),
        text,
        is_binary,
        size,
        truncated,
        read_bytes,
    })
}

/// One window of a zstd-compressed file, in its decompressed bytes — or
/// `None` when the file is not zstd at all, for the plain read to take.
///
/// Stateless, like every read here: the window decodes from the frame's
/// start, skips `start` bytes, keeps `cap`. The size is the frame's own
/// content size (codex always writes it); without one, the stream is
/// counted to its end, within [`INFLATE_REACH`]. A stream that will not
/// decode — corrupt, or a window past [`INFLATE_WINDOW_LOG_MAX`] — reads as
/// what it is to a text reader: not text.
/// A compressed file's decoder, kept between two windows of one walk.
///
/// A reader walks a file window by window, each starting where the last one
/// ended. Decoding every window from the frame's start made that walk
/// quadratic: measured on a 24 MiB rollout, 8 MiB read in 256 KiB windows
/// took ~52 ms against ~3 ms for the same text plain. The next window picks
/// up the decoder where the last one left it. One is kept, for the file it
/// was reading (its path, length and modification time) at the offset it
/// stands at; any other read starts afresh.
struct Resume {
    file: std::path::PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
    at: u64,
    decoder: zstd::stream::read::Decoder<'static, std::io::BufReader<std::io::Take<fs::File>>>,
}

static INFLATE_RESUME: std::sync::Mutex<Option<Resume>> = std::sync::Mutex::new(None);

fn read_inflated(file: &std::path::Path, start: u64, cap: u64) -> Result<Option<FsFile>, String> {
    let mut head = Vec::with_capacity(ZSTD_FRAME_HEADER_MAX);
    fs::File::open(file)
        .map_err(|e| format!("cannot open: {e}"))?
        .take(ZSTD_FRAME_HEADER_MAX as u64)
        .read_to_end(&mut head)
        .map_err(|e| format!("cannot read: {e}"))?;
    if !head.starts_with(&ZSTD_MAGIC) {
        return Ok(None);
    }
    if start.saturating_add(cap) > INFLATE_REACH {
        return Err(format!(
            "a compressed file is read within its first {INFLATE_REACH} bytes; {start}+{cap} reaches past them"
        ));
    }
    let path = file.to_string_lossy().into_owned();
    let not_text = |size: u64| FsFile {
        path: path.clone(),
        text: None,
        is_binary: true,
        size,
        truncated: false,
        read_bytes: 0,
    };
    let known = zstd::zstd_safe::get_frame_content_size(&head).ok().flatten();
    let meta = fs::metadata(file).map_err(|e| format!("cannot stat: {e}"))?;
    let (len, modified) = (meta.len(), meta.modified().ok());
    // The decoder the last window left at exactly this point, if it did.
    let kept = INFLATE_RESUME
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
        .filter(|resume| resume.file == file && resume.len == len && resume.modified == modified && resume.at == start);
    let fresh = kept.is_none();
    let mut decoder = match kept {
        Some(resume) => resume.decoder,
        None => {
            let input = fs::File::open(file).map_err(|e| format!("cannot open: {e}"))?.take(INFLATE_INPUT_MAX);
            let Ok(mut decoder) = zstd::stream::read::Decoder::new(input) else {
                return Ok(Some(not_text(known.unwrap_or(0))));
            };
            if decoder.window_log_max(INFLATE_WINDOW_LOG_MAX).is_err() {
                return Ok(Some(not_text(known.unwrap_or(0))));
            }
            decoder
        }
    };
    let mut buf = Vec::new();
    let skipped = if fresh {
        std::io::copy(&mut (&mut decoder).take(start), &mut std::io::sink()).map(|_| ())
    } else {
        Ok(())
    };
    if skipped.and_then(|()| (&mut decoder).take(cap).read_to_end(&mut buf)).is_err() {
        return Ok(Some(not_text(known.unwrap_or(0))));
    }
    let reached = start.saturating_add(buf.len() as u64);
    let size = match known {
        // Kept for the next window, which starts where this one ended — a
        // stream counted to its end has nothing left to keep.
        Some(size) => {
            if size > reached {
                if let Ok(mut slot) = INFLATE_RESUME.lock() {
                    *slot = Some(Resume { file: file.to_path_buf(), len, modified, at: reached, decoder });
                }
            }
            size
        }
        None => {
            let rest = std::io::copy(&mut (&mut decoder).take(INFLATE_REACH - reached.min(INFLATE_REACH)), &mut std::io::sink())
                .unwrap_or(0);
            reached + rest
        }
    };
    let read_bytes = buf.len() as u64;
    let truncated = size > start.saturating_add(read_bytes);
    let Decoded { text, is_binary, read_bytes } = decode_text(buf, truncated);
    Ok(Some(FsFile { path, text, is_binary, size, truncated, read_bytes }))
}

/// Bytes read from a file, as a reader receives them.
pub(crate) struct Decoded {
    pub text: Option<String>,
    pub is_binary: bool,
    /// How many of the bytes the text holds — all of them, unless a cut
    /// character's stub was dropped (see below).
    pub read_bytes: u64,
}

/// Whether `buf` is text, and the text. `truncated` says the read stopped
/// because WE stopped it — the file's own working-tree read, or a stored
/// file git capped (`project_git_file_at`); the one rule for both.
pub(crate) fn decode_text(buf: Vec<u8>, truncated: bool) -> Decoded {
    let mut read_bytes = buf.len() as u64;
    // Binary detection, the git heuristic: a NUL byte means binary. Otherwise
    // try to decode UTF-8; invalid bytes are binary too (can't render as text).
    //
    // ONE exception, and it is about OUR cut rather than the file: a read
    // stopped at the cap can land in the middle of a multi-byte character, and
    // the dangling bytes are ours. Dropping the whole text for them turns a
    // 10 MB conversation into "binary file" — the worst answer available,
    // because it is not "less" but "nothing".
    //
    // BOTH guards are load-bearing, and each blocks a lie the other would let
    // through. `error_len() == None` means the sequence ran out of INPUT
    // rather than being wrong; `Some` is a genuinely bad byte, and rescuing
    // that would let a corrupt file masquerade as a merely truncated one.
    // `truncated` means the input ended because WE stopped it; a file read
    // whole that ends mid-sequence is malformed on its own, and rescuing it
    // would hand back text with `truncated: false` — no shortfall, no mark,
    // a silent loss where today's `is_binary` at least shouts.
    //
    // The NUL branch above is untouched on purpose: a NUL byte says what the
    // file IS, and this fixes what our READ did.
    let (text, is_binary) = if buf.contains(&0) {
        (None, true)
    } else {
        match String::from_utf8(buf) {
            Ok(text) => (Some(text), false),
            Err(e) if truncated && e.utf8_error().error_len().is_none() => {
                let keep = e.utf8_error().valid_up_to();
                let mut bytes = e.into_bytes();
                bytes.truncate(keep);
                // `read_bytes` marks where the RETURNED TEXT stops, so the
                // dropped stub leaves with it: a shortfall computed from a
                // length the text does not have would be false by exactly the
                // bytes we just refused to guess about.
                read_bytes = keep as u64;
                // A second validation pass, on the rare branch only: the
                // common path moves `buf` into the String with one check and
                // no copy, and paying re-validation here buys a safe `expect`
                // instead of an unchecked conversion. It cannot fire —
                // `valid_up_to()` is by definition the length of the longest
                // valid prefix.
                let text = String::from_utf8(bytes)
                    .expect("valid_up_to() bounds the longest valid prefix");
                (Some(text), false)
            }
            Err(_) => (None, true),
        }
    };
    Decoded {
        text,
        is_binary,
        read_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_fs::testing::{roots, temp_root, write};

    /// The read as every plain-file test here asks it: on disk as it is.
    /// The compressed reads below name `inflate` themselves.
    fn project_fs_read_file(
        path: String,
        roots: Vec<String>,
        everywhere: bool,
        max_bytes: Option<u64>,
        offset: Option<u64>,
    ) -> Result<FsFile, String> {
        super::project_fs_read_file(path, roots, everywhere, max_bytes, offset, None)
    }

    /// A compressed read of `name` under `root`.
    fn inflated(root: &std::path::Path, name: &str, max_bytes: Option<u64>, offset: Option<u64>) -> Result<FsFile, String> {
        super::project_fs_read_file(
            root.join(name).to_string_lossy().into_owned(),
            roots(root),
            false,
            max_bytes,
            offset,
            Some(true),
        )
    }

    fn write_bytes(path: &std::path::Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
    }

    /// A rollout-shaped text: `lines` records, one per line.
    fn jsonl(lines: usize) -> String {
        (0..lines).map(|i| format!("{{\"i\":{i},\"pad\":\"{}\"}}\n", "x".repeat(40))).collect()
    }

    // ---- read_file, inflated (task-418) ----

    #[test]
    fn an_inflated_read_of_a_zstd_file_is_its_text_measured_in_decompressed_bytes() {
        // Both frame shapes: with the content size in its header (codex writes
        // it) and without (a stream encoder that was never told the size).
        let root = temp_root();
        let text = jsonl(200);
        write_bytes(&root.join("sized.zst"), &zstd::bulk::compress(text.as_bytes(), 3).unwrap());
        write_bytes(&root.join("unsized.zst"), &zstd::stream::encode_all(text.as_bytes(), 3).unwrap());

        for name in ["sized.zst", "unsized.zst"] {
            let file = inflated(&root, name, None, None).unwrap();
            assert_eq!(file.text.as_deref(), Some(text.as_str()), "{name}");
            assert_eq!(file.size, text.len() as u64, "{name}");
            assert!(!file.truncated, "{name}");
        }
    }

    /// Every window of `name` from offset zero, joined.
    fn walk_inflated(root: &std::path::Path, name: &str, window: u64) -> String {
        let mut at = 0;
        let mut whole = String::new();
        loop {
            let read = inflated(root, name, Some(window), Some(at)).unwrap();
            whole.push_str(read.text.as_deref().unwrap());
            at += read.read_bytes;
            if !read.truncated {
                return whole;
            }
        }
    }

    #[test]
    fn windows_of_a_zstd_file_reassemble_it_and_stop_at_its_end() {
        let root = temp_root();
        let text = jsonl(500);
        write_bytes(&root.join("r.jsonl.zst"), &zstd::bulk::compress(text.as_bytes(), 3).unwrap());
        write_bytes(&root.join("u.jsonl.zst"), &zstd::stream::encode_all(text.as_bytes(), 3).unwrap());

        assert_eq!(walk_inflated(&root, "r.jsonl.zst", 4_096), text);
        assert_eq!(walk_inflated(&root, "u.jsonl.zst", 4_096), text);
        // Past the end: nothing, and nothing left to come back for.
        let past = inflated(&root, "r.jsonl.zst", Some(10), Some(text.len() as u64 + 5)).unwrap();
        assert_eq!((past.read_bytes, past.truncated), (0, false));
    }

    #[test]
    fn a_kept_decoder_never_answers_a_read_it_does_not_stand_at() {
        // A walk keeps its decoder between windows; a read elsewhere — an
        // earlier window again, another file between two windows, a file
        // rewritten under the walk — must read what is there, not continue.
        let root = temp_root();
        let a = jsonl(400);
        let b: String = jsonl(400).replace("\"i\"", "\"j\"");
        write_bytes(&root.join("a.zst"), &zstd::bulk::compress(a.as_bytes(), 3).unwrap());
        write_bytes(&root.join("b.zst"), &zstd::bulk::compress(b.as_bytes(), 3).unwrap());

        let first = inflated(&root, "a.zst", Some(1_000), Some(0)).unwrap();
        let other = inflated(&root, "b.zst", Some(1_000), Some(0)).unwrap();
        let next = inflated(&root, "a.zst", Some(1_000), Some(first.read_bytes)).unwrap();
        let again = inflated(&root, "a.zst", Some(1_000), Some(0)).unwrap();
        assert_eq!(first.text.as_deref(), Some(&a[..1_000]));
        assert_eq!(other.text.as_deref(), Some(&b[..1_000]));
        assert_eq!(next.text.as_deref(), Some(&a[1_000..2_000]));
        assert_eq!(again.text.as_deref(), Some(&a[..1_000]));

        // Rewritten between two windows: the next one reads the new file.
        let _ = inflated(&root, "a.zst", Some(1_000), Some(0)).unwrap();
        let c: String = jsonl(400).replace("\"i\"", "\"k\"");
        write_bytes(&root.join("a.zst"), &zstd::bulk::compress(c.as_bytes(), 3).unwrap());
        let after = inflated(&root, "a.zst", Some(1_000), Some(1_000)).unwrap();
        assert_eq!(after.text.as_deref(), Some(&c[1_000..2_000]));
    }

    #[test]
    fn a_file_that_is_not_zstd_reads_as_on_disk_even_when_asked_to_inflate() {
        let root = temp_root();
        write(&root.join("plain.jsonl"), "{\"a\":1}\n");
        let file = inflated(&root, "plain.jsonl", None, None).unwrap();
        assert_eq!(file.text.as_deref(), Some("{\"a\":1}\n"));
        // And without asking, a .zst is the bytes on disk: not text.
        write_bytes(&root.join("r.jsonl.zst"), &zstd::stream::encode_all(&b"{}\n"[..], 3).unwrap());
        let raw = project_fs_read_file(
            root.join("r.jsonl.zst").to_string_lossy().into_owned(),
            roots(&root),
            false,
            None,
            None,
        )
        .unwrap();
        assert!(raw.text.is_none());
    }

    #[test]
    fn a_bomb_is_read_a_window_at_a_time_and_never_past_its_reach() {
        // 70 MiB of zeros compresses to a few KB: the window is capped on
        // what comes OUT, and how deep a read may start is capped too.
        let root = temp_root();
        let zeros = vec![b'0'; 70 * 1024 * 1024];
        write_bytes(&root.join("bomb.zst"), &zstd::stream::encode_all(&zeros[..], 3).unwrap());

        let window = inflated(&root, "bomb.zst", Some(1024), None).unwrap();
        assert_eq!((window.read_bytes, window.truncated), (1024, true));
        assert!(inflated(&root, "bomb.zst", Some(1024), Some(INFLATE_REACH)).is_err());
    }

    #[test]
    fn a_frame_that_wants_a_window_past_the_limit_is_not_text() {
        // No content size, a 16 MiB window, and data to fill it: what a
        // crafted frame demanding memory looks like.
        let root = temp_root();
        // TEXT, so a decoder that let the window through would read it as
        // text — the refusal is what makes it not.
        let data: Vec<u8> = (0..9 * 1024 * 1024u32).map(|i| b'a' + ((i.wrapping_mul(2654435761) >> 24) % 26) as u8).collect();
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        encoder.include_contentsize(false).unwrap();
        encoder.window_log(24).unwrap();
        std::io::Write::write_all(&mut encoder, &data).unwrap();
        write_bytes(&root.join("wide.zst"), &encoder.finish().unwrap());

        let file = inflated(&root, "wide.zst", Some(1024), None).unwrap();
        assert!(file.text.is_none());
        assert!(file.is_binary);
    }

    // ---- read_dir ----

    #[test]
    fn read_dir_lists_children_with_kinds_and_file_sizes() {
        let root = temp_root();
        write(&root.join("a.txt"), "hello");
        fs::create_dir_all(root.join("sub")).unwrap();

        let mut entries =
            project_fs_read_dir(root.to_string_lossy().into_owned(), roots(&root), false).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "a.txt");
        assert_eq!(entries[0].kind, FsKind::File);
        assert_eq!(entries[0].size, Some(5));
        assert_eq!(entries[1].name, "sub");
        assert_eq!(entries[1].kind, FsKind::Dir);
        assert_eq!(entries[1].size, None);
    }

    #[test]
    fn read_dir_child_path_is_absolute_and_readable_back() {
        let root = temp_root();
        write(&root.join("nested/deep.txt"), "x");

        let top =
            project_fs_read_dir(root.to_string_lossy().into_owned(), roots(&root), false).unwrap();
        let nested = top.iter().find(|e| e.name == "nested").unwrap();

        // The child's own path feeds the next lazy call unchanged.
        let inner = project_fs_read_dir(nested.path.clone(), roots(&root), false).unwrap();
        assert_eq!(inner.len(), 1);
        assert_eq!(inner[0].name, "deep.txt");
    }

    #[test]
    #[cfg(unix)]
    fn read_dir_reports_a_symlink_without_following_it() {
        let root = temp_root();
        write(&root.join("target.txt"), "content");
        std::os::unix::fs::symlink(root.join("target.txt"), root.join("link")).unwrap();

        let entries =
            project_fs_read_dir(root.to_string_lossy().into_owned(), roots(&root), false).unwrap();
        let link = entries.iter().find(|e| e.name == "link").unwrap();
        assert_eq!(link.kind, FsKind::Symlink);
        assert_eq!(link.size, None);
    }

    // ---- containment (resolve_within via the commands) ----

    #[test]
    fn read_dir_refuses_a_dotdot_escape() {
        let root = temp_root();
        let inside = root.join("ws");
        fs::create_dir_all(&inside).unwrap();
        write(&root.join("outside/secret.txt"), "nope");

        // Root allows only `ws`; `ws/../outside` climbs out.
        let escape = inside.join("../outside").to_string_lossy().into_owned();
        let result = project_fs_read_dir(escape, roots(&inside), false);
        assert!(result.is_err());
    }

    #[test]
    fn read_dir_refuses_an_absolute_path_outside_the_roots() {
        let root = temp_root();
        let inside = root.join("ws");
        fs::create_dir_all(&inside).unwrap();
        let elsewhere = temp_root(); // a real dir, but not under `inside`

        let result = project_fs_read_dir(
            elsewhere.to_string_lossy().into_owned(),
            roots(&inside),
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    #[cfg(unix)]
    fn read_file_refuses_a_symlink_escaping_the_roots() {
        let root = temp_root();
        let inside = root.join("ws");
        fs::create_dir_all(&inside).unwrap();
        write(&root.join("secret.txt"), "outside");
        std::os::unix::fs::symlink(root.join("secret.txt"), inside.join("leak")).unwrap();

        // The symlink lives inside the root, but its real target is outside.
        let result = project_fs_read_file(
            inside.join("leak").to_string_lossy().into_owned(),
            roots(&inside),
            false,
            None,
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn everywhere_scope_bypasses_the_root_check() {
        let root = temp_root();
        write(&root.join("a.txt"), "hi");
        let unrelated = temp_root();

        // Empty roots + everywhere = read anything that exists.
        let entries =
            project_fs_read_dir(root.to_string_lossy().into_owned(), vec![], true).unwrap();
        assert_eq!(entries.len(), 1);
        let _ = unrelated;
    }

    #[test]
    fn workspace_scope_with_empty_roots_authorizes_nothing() {
        let root = temp_root();
        write(&root.join("a.txt"), "hi");

        let result = project_fs_read_dir(root.to_string_lossy().into_owned(), vec![], false);
        assert!(result.is_err());
    }

    // ---- read_file ----

    #[test]
    fn read_file_returns_text_for_a_utf8_file() {
        let root = temp_root();
        write(&root.join("code.rs"), "fn main() {}\n");

        let file = project_fs_read_file(
            root.join("code.rs").to_string_lossy().into_owned(),
            roots(&root),
            false,
            None,
            None,
        )
        .unwrap();
        assert_eq!(file.text.as_deref(), Some("fn main() {}\n"));
        assert!(!file.is_binary);
        assert!(!file.truncated);
        assert_eq!(file.size, 13);
    }

    #[test]
    fn read_file_flags_a_binary_file_and_returns_no_text() {
        let root = temp_root();
        fs::write(root.join("blob.bin"), [0x00, 0x01, 0xff, 0x00]).unwrap();

        let file = project_fs_read_file(
            root.join("blob.bin").to_string_lossy().into_owned(),
            roots(&root),
            false,
            None,
            None,
        )
        .unwrap();
        assert!(file.is_binary);
        assert_eq!(file.text, None);
    }

    #[test]
    fn read_file_truncates_at_the_cap_and_flags_it() {
        let root = temp_root();
        write(&root.join("big.txt"), &"a".repeat(100));

        let file = project_fs_read_file(
            root.join("big.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            Some(10),
            None,
        )
        .unwrap();
        assert_eq!(file.text.as_deref(), Some(&"a".repeat(10)[..]));
        assert!(file.truncated);
        assert_eq!(file.size, 100);
        // Where the read STOPPED, from the read itself. A caller inferring it
        // from its own `max_bytes` would be right only until it asked above
        // the ceiling — which is clamped here, silently and by design.
        assert_eq!(file.read_bytes, 10);
    }

    /// A cap landing inside a multi-byte character must not cost the whole
    /// text.
    ///
    /// This is the failure the mark exists to prevent, and it is live: a
    /// Cyrillic-dense transcript over the ceiling breaks here roughly as often
    /// as a coin lands heads, and the boundary moves with every append. Before
    /// this, `text` came back `None`, every reader saw `is_binary`, and a ten
    /// megabyte conversation rendered as "no content" — not "less", but
    /// "nothing".
    #[test]
    fn read_file_rescues_a_tail_split_mid_character() {
        let root = temp_root();
        // Nine ASCII bytes then one two-byte character: a cap of ten stops
        // between its lead byte and its continuation.
        write(&root.join("split.txt"), &format!("{}Д", "a".repeat(9)));

        let file = project_fs_read_file(
            root.join("split.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            Some(10),
            None,
        )
        .unwrap();
        assert_eq!(file.text.as_deref(), Some(&"a".repeat(9)[..]));
        assert!(!file.is_binary);
        // The read is STILL short, and says so: rescuing the prefix answers
        // "what can be shown", never "the file was whole".
        assert!(file.truncated);
        assert_eq!(file.size, 11);
        // The dropped stub leaves with the number. `read_bytes` marks where
        // the TEXT stops, so reporting the cap here would overstate the read
        // by exactly the bytes we refused to guess about — a false number in
        // the field that exists to keep numbers honest.
        assert_eq!(file.read_bytes, 9);
    }

    /// A genuinely bad byte stays binary even when the read was also short.
    ///
    /// Without this guard the rescue above would let corruption masquerade as
    /// our own cut: a file damaged at byte three would come back as text with
    /// a "partly shown" mark, and the reader would blame the ceiling for a
    /// hole the ceiling did not make. `error_len()` tells the two apart —
    /// `None` is "ran out of input", `Some` is "this byte is wrong" — and
    /// only the first is ours to repair.
    #[test]
    fn read_file_keeps_a_corrupt_short_read_binary() {
        let root = temp_root();
        let mut bytes = b"abc".to_vec();
        bytes.push(0xFF);
        bytes.extend_from_slice(b"defghij");
        fs::write(root.join("bad.txt"), &bytes).unwrap();

        let file = project_fs_read_file(
            root.join("bad.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            Some(8),
            None,
        )
        .unwrap();
        assert!(file.is_binary);
        assert_eq!(file.text, None);
        assert!(file.truncated);
    }

    /// A file read WHOLE that ends mid-sequence is malformed on its own, and
    /// stays binary.
    ///
    /// `error_len() == None` means "the sequence ran out of input" — and the
    /// input ends either at our cap or at the file's own end; the error does
    /// not distinguish them, so `truncated` must. Rescue here would hand back
    /// text with `truncated: false`: no shortfall, no mark, and the lost tail
    /// silent. That is worse than today's answer, which at least shouts "not
    /// text".
    #[test]
    fn read_file_keeps_a_whole_file_ending_mid_character_binary() {
        let root = temp_root();
        let mut bytes = b"ok".to_vec();
        bytes.push(0xD0); // lead byte of a two-byte character, never completed
        fs::write(root.join("cut.txt"), &bytes).unwrap();

        let file = project_fs_read_file(
            root.join("cut.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            None,
            None,
        )
        .unwrap();
        assert!(file.is_binary);
        assert_eq!(file.text, None);
        // Nothing was cut BY US — the file simply ends this way.
        assert!(!file.truncated);
    }

    /// The wire shape of a file read, pinned key by key.
    ///
    /// Everything below this struct is a CAST on the other side: the webview
    /// names these fields in TypeScript and nothing at runtime checks that
    /// they arrived. So a rename here — or a serde attribute lost in an edit —
    /// would not fail a build, a type-check or any existing test: the field
    /// would simply be `undefined` wherever it is read, and the first sign of
    /// it would be a blank in the interface. This test is the only thing that
    /// notices.
    #[test]
    fn read_file_wire_json_names_every_field_in_camel_case() {
        let root = temp_root();
        write(&root.join("a.txt"), "hi");

        let file = project_fs_read_file(
            root.join("a.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            None,
            None,
        )
        .unwrap();

        let wire = serde_json::to_value(&file).unwrap();
        let mut keys: Vec<&str> = wire.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["isBinary", "path", "readBytes", "size", "text", "truncated"],
        );
        assert_eq!(wire["readBytes"], 2);
        assert_eq!(wire["size"], 2);
        assert_eq!(wire["truncated"], false);
    }

    /// A window: the read starts at `offset` and `read_bytes` counts from
    /// there, not from the file's start.
    ///
    /// This is the whole point of the parameter — a caller walking a large
    /// file holds one window at a time instead of the file. Were `read_bytes`
    /// anchored to the file, a caller computing its next offset from it would
    /// be adding in everything it had already passed, and the walk would skip
    /// forward exponentially.
    #[test]
    fn read_file_reads_a_window_starting_at_the_offset() {
        let root = temp_root();
        write(&root.join("big.txt"), "0123456789abcdef");

        let file = project_fs_read_file(
            root.join("big.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            Some(4),
            Some(10),
        )
        .unwrap();
        assert_eq!(file.text.as_deref(), Some("abcd"));
        assert_eq!(file.read_bytes, 4);
        // The FILE's length, not the window's — a caller needs it to notice
        // that the store grew under a resumed walk.
        assert_eq!(file.size, 16);
        assert!(file.truncated);
    }

    /// Windows chained by `offset + read_bytes` reassemble the file exactly,
    /// and the last one is not truncated.
    ///
    /// The pair of numbers IS the resume protocol; this walks it the way a
    /// streaming reader does. A `truncated` computed against the file rather
    /// than against the window's end would stay true on the final window, and
    /// a reader trusting it would ask forever.
    #[test]
    fn read_file_windows_chained_by_offset_reassemble_the_file() {
        let root = temp_root();
        let content: String = (0..50).map(|i| format!("line {i}\n")).collect();
        write(&root.join("log.jsonl"), &content);

        let mut at = 0u64;
        let mut seen = String::new();
        loop {
            let file = project_fs_read_file(
                root.join("log.jsonl").to_string_lossy().into_owned(),
                roots(&root),
                false,
                Some(30),
                Some(at),
            )
            .unwrap();
            seen.push_str(file.text.as_deref().unwrap());
            at += file.read_bytes;
            if !file.truncated {
                break;
            }
            assert!(file.read_bytes > 0, "a truncated window must advance");
        }
        assert_eq!(seen, content);
        assert_eq!(at, content.len() as u64);
    }

    /// An offset at or past the end reads nothing and reports no remainder.
    ///
    /// The terminating case of the walk above: "empty and not truncated" is
    /// how a reader learns it is done. Reporting truncation here — the file
    /// being longer than the zero bytes read — would loop it on emptiness.
    #[test]
    fn read_file_offset_past_the_end_reads_nothing_and_ends() {
        let root = temp_root();
        write(&root.join("a.txt"), "hello");

        let file = project_fs_read_file(
            root.join("a.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            None,
            Some(5),
        )
        .unwrap();
        assert_eq!(file.text.as_deref(), Some(""));
        assert_eq!(file.read_bytes, 0);
        assert!(!file.truncated);
    }

    /// A window ending mid-character drops the stub AND the bytes for it, so
    /// the next window re-reads the whole character.
    ///
    /// The rescue and the resume protocol have to agree: the stub is not in
    /// the text, so it must not be in `read_bytes` either — otherwise the next
    /// window would start after a character nobody ever received.
    #[test]
    fn read_file_window_split_mid_character_resumes_before_it() {
        let root = temp_root();
        write(&root.join("split.txt"), "abДef");

        let first = project_fs_read_file(
            root.join("split.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            Some(3), // "ab" plus the lead byte of "Д"
            None,
        )
        .unwrap();
        assert_eq!(first.text.as_deref(), Some("ab"));
        assert_eq!(first.read_bytes, 2);

        let second = project_fs_read_file(
            root.join("split.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            None,
            Some(first.read_bytes),
        )
        .unwrap();
        assert_eq!(second.text.as_deref(), Some("Дef"));
        assert!(!second.truncated);
    }

    /// An offset landing inside a character is reported, not quietly moved.
    ///
    /// Skipping to the next boundary would give `offset` a second, invisible
    /// meaning: the caller's arithmetic and the host's would drift apart by a
    /// byte or two with nothing saying so. A caller resuming from a boundary
    /// it framed itself never reaches this.
    #[test]
    fn read_file_offset_inside_a_character_is_binary_not_silently_moved() {
        let root = temp_root();
        write(&root.join("split.txt"), "Дa");

        let file = project_fs_read_file(
            root.join("split.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            None,
            Some(1), // the continuation byte of "Д"
        )
        .unwrap();
        assert!(file.is_binary);
        assert_eq!(file.text, None);
    }

    /// A FOUR-byte character split by a window drops all of its stub, however
    /// many bytes of it arrived.
    ///
    /// Two-byte characters were the case that provoked the rescue, and a
    /// rescue that walked back a fixed distance would pass that test and lose
    /// bytes here. Its twin in `packages/plugin-api/src/testing.test.ts`
    /// asserts the same numbers against the double every equivalence run is
    /// measured through: a corner neither implementation was written against
    /// is where the two would first disagree.
    #[test]
    fn read_file_window_split_inside_a_four_byte_character_drops_the_whole_stub() {
        let root = temp_root();
        write(&root.join("wide.txt"), "ab😀cd");

        // Two ASCII bytes, then two of the emoji's four.
        let first = project_fs_read_file(
            root.join("wide.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            Some(4),
            None,
        )
        .unwrap();
        assert_eq!(first.text.as_deref(), Some("ab"));
        assert_eq!(first.read_bytes, 2);
        assert!(first.truncated);

        let second = project_fs_read_file(
            root.join("wide.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            None,
            Some(first.read_bytes),
        )
        .unwrap();
        assert_eq!(second.text.as_deref(), Some("😀cd"));
        assert!(!second.truncated);
    }

    /// A zero cap reads nothing and still reports a remainder.
    ///
    /// The shape that can spin a walking reader forever: truncated, yet not
    /// advancing. Pinned on BOTH sides so the reader's guard against it is
    /// written against a behaviour that is agreed rather than assumed.
    #[test]
    fn read_file_a_zero_cap_reads_nothing_but_still_reports_a_remainder() {
        let root = temp_root();
        write(&root.join("a.txt"), "hello");

        let file = project_fs_read_file(
            root.join("a.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            Some(0),
            None,
        )
        .unwrap();
        assert_eq!(file.text.as_deref(), Some(""));
        assert_eq!(file.read_bytes, 0);
        assert!(file.truncated);
    }

    #[test]
    fn read_file_rejects_a_directory() {
        let root = temp_root();
        fs::create_dir_all(root.join("adir")).unwrap();

        let result = project_fs_read_file(
            root.join("adir").to_string_lossy().into_owned(),
            roots(&root),
            false,
            None,
            None,
        );
        assert!(result.is_err());
    }

}
