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
use std::io::Read as _;

use serde::Serialize;

use crate::containment::{expand_home, resolve_within};

/// Default cap for a single [`project_fs_read_file`] read, when the caller
/// names none. A code viewer wants text, not a 2 GB blob paged into the
/// webview, so the common file is read whole and a large one comes back
/// `truncated`.
const DEFAULT_MAX_FILE_BYTES: u64 = 1024 * 1024;

/// Hard ceiling on what a caller may request, so a plugin passing an enormous
/// `maxBytes` can't turn a read into an out-of-memory. Above the default to
/// leave headroom for a legitimately large source file.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

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
/// the file's FULL length; `truncated` says the returned text stops at the
/// read cap; `read_bytes` says where it stopped — and where the TEXT stops,
/// which is the same thing except when a capped read split a multi-byte
/// character: the dangling stub is dropped and `read_bytes` drops with it, so
/// the number always describes the text actually handed over.
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
    let dir = resolve_within(&expand_home(&path)?, &roots, everywhere)?;
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
#[tauri::command(async)]
pub fn project_fs_read_file(
    path: String,
    roots: Vec<String>,
    everywhere: bool,
    max_bytes: Option<u64>,
) -> Result<FsFile, String> {
    let file = resolve_within(&expand_home(&path)?, &roots, everywhere)?;
    let meta = fs::metadata(&file).map_err(|e| format!("cannot stat: {e}"))?;
    if meta.is_dir() {
        return Err(format!("path is a directory: {path}"));
    }
    let size = meta.len();
    let cap = max_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES).min(MAX_FILE_BYTES);

    let handle = fs::File::open(&file).map_err(|e| format!("cannot open: {e}"))?;
    let mut buf = Vec::new();
    handle
        .take(cap)
        .read_to_end(&mut buf)
        .map_err(|e| format!("cannot read: {e}"))?;
    let mut read_bytes = buf.len() as u64;
    let truncated = size > read_bytes;

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

    Ok(FsFile {
        path: file.to_string_lossy().into_owned(),
        text,
        is_binary,
        size,
        truncated,
        read_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_fs::testing::{roots, temp_root, write};

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
        write(&root.join("ru.txt"), &format!("{}Д", "a".repeat(9)));

        let file = project_fs_read_file(
            root.join("ru.txt").to_string_lossy().into_owned(),
            roots(&root),
            false,
            Some(10),
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

    #[test]
    fn read_file_rejects_a_directory() {
        let root = temp_root();
        fs::create_dir_all(root.join("adir")).unwrap();

        let result = project_fs_read_file(
            root.join("adir").to_string_lossy().into_owned(),
            roots(&root),
            false,
            None,
        );
        assert!(result.is_err());
    }

}
