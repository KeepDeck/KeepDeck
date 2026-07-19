//! Reading PROJECT files for the plugin `fs` capability.
//!
//! This is the backend the `services.fs` plugin service lands on — distinct
//! from [`crate::plugins_fs`], which serves a PLUGIN'S OWN bundle files over
//! `kdplugin://`. Here a plugin reads the USER'S project tree: one directory's
//! immediate children ([`project_fs_read_dir`]) and one file's contents
//! ([`project_fs_read_file`]). Both are lazy and non-recursive — a file-tree
//! UI expands a node by asking for that node's children, so a giant
//! `node_modules` never loads until (and unless) someone opens it.
//!
//! ## The scope boundary
//!
//! The `fs` capability declares a scope (`packages/plugin-api`
//! `capabilities.ts`): `workspace` = the workspace folder and its panes'
//! worktrees, `everywhere` = no restriction (consent shouts it). The HOST
//! resolves that scope into a concrete set of allowed roots from live deck
//! state and passes them in with every call; this module enforces containment.
//!
//! Enforcement is [`crate::containment::resolve_within`] (shared with the
//! other project-facing service backends), the same canonicalize-then-`starts_with`
//! model [`crate::plugins_fs::safe_lookup`] uses: resolving `..` and symlinks
//! ON DISK is the only reliable escape guard, so a `../../etc/passwd`, an
//! absolute path outside the roots, or a symlink pointing out all resolve to a
//! real location the containment check then rejects. `everywhere` skips the
//! containment step but still canonicalizes (and still caps reads) — the
//! difference between the two scopes is exactly whether the roots are
//! consulted, nothing else.
//!
//! A workspace-scoped call with an EMPTY root set reads nothing: the safe
//! default for a plugin whose deck currently has no eligible folder open.
//!
//! Read-only by design (v1): there is no write/create/delete surface here —
//! that needs its own capability, deliberately absent until it exists.

use std::fs;
use std::io::Read as _;
use std::path::Path;

use notify::{Event, EventKind};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::containment::resolve_within;
use crate::fswatch;

/// Default cap for a single [`project_fs_read_file`] read, when the caller
/// names none. A code viewer wants text, not a 2 GB blob paged into the
/// webview, so the common file is read whole and a large one comes back
/// `truncated`.
const DEFAULT_MAX_FILE_BYTES: u64 = 1024 * 1024;

/// Expand a leading `~/` so a plugin can name its own store without knowing
/// the user's home (host facts stay narrow). Containment still applies.
fn expand_home(path: &str) -> Result<String, String> {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var("HOME").map_err(|_| "no home directory")?;
        return Ok(format!("{home}/{rest}"));
    }
    Ok(path.to_string())
}

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
/// read cap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsFile {
    pub path: String,
    pub text: Option<String>,
    pub is_binary: bool,
    pub size: u64,
    pub truncated: bool,
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
    let truncated = size > buf.len() as u64;

    // Binary detection, the git heuristic: a NUL byte means binary. Otherwise
    // try to decode UTF-8; invalid bytes are binary too (can't render as text).
    let (text, is_binary) = if buf.contains(&0) {
        (None, true)
    } else {
        match String::from_utf8(buf) {
            Ok(text) => (Some(text), false),
            Err(_) => (None, true),
        }
    };

    Ok(FsFile {
        path: file.to_string_lossy().into_owned(),
        text,
        is_binary,
        size,
        truncated,
    })
}

// ---------------------------------------------------------------- watching

/// The Tauri event delivering "this watched directory's listing changed" to the
/// webview. Payload is [`ProjectFsChange`]; mirrored by `src/ipc/projectFs.ts`.
pub const PROJECT_FS_CHANGE_EVENT: &str = "deck://project-fs/change";

/// One directory-changed notification. `path` is the directory AS REGISTERED by
/// the webview — its join key back to the tree node, never canonicalized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFsChange {
    pub path: String,
}

/// The live project-file watchers — a shared [`fswatch::WatchRegistry`] keyed by
/// registered directory path. Tauri managed state; dropping an entry stops it.
#[derive(Default)]
pub struct ProjectFsWatchers(fswatch::WatchRegistry);

/// Whether an event changes a directory's LISTING — a child created, removed, or
/// renamed — versus mere content or access. A file tree shows names, not bytes,
/// so a file being written (`Modify(Data)`) must NOT re-read the tree and spam
/// the UI; only structural changes do. Unknown/coarse kinds count as structural
/// (a spare re-read beats a missed rename).
fn is_structural_change(event: &Event) -> bool {
    use notify::event::ModifyKind;
    !matches!(
        event.kind,
        EventKind::Access(_)
            | EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Metadata(_))
    )
}

/// Watch `dir` for structural changes, calling `deliver(registered)` on each.
/// Split from the command so the pipeline is testable without a Tauri app.
fn spawn_project_watch(
    dir: &Path,
    registered: String,
    deliver: impl Fn(String) + Send + 'static,
) -> Result<notify::RecommendedWatcher, String> {
    fswatch::watch_dir(dir, move |event| {
        if is_structural_change(event) {
            deliver(registered.clone());
        }
    })
}

/// Start watching one directory for entry changes, emitting
/// [`PROJECT_FS_CHANGE_EVENT`] whenever its listing changes. Scoped exactly like
/// a read: the path must sit inside the caller's fs roots ([`resolve_within`]).
/// Idempotent per registered path — re-registering replaces the old watcher.
#[tauri::command(async)]
pub fn project_fs_watch(
    app: AppHandle,
    watchers: State<ProjectFsWatchers>,
    path: String,
    roots: Vec<String>,
    everywhere: bool,
) -> Result<(), String> {
    let dir = resolve_within(&path, &roots, everywhere)?;
    let emitter = app.clone();
    let watcher = spawn_project_watch(&dir, path.clone(), move |registered| {
        let _ = emitter.emit(
            PROJECT_FS_CHANGE_EVENT,
            &ProjectFsChange { path: registered },
        );
    })?;
    watchers.0.insert(path, watcher);
    Ok(())
}

/// Stop watching a directory (the tree collapsed it, re-rooted, or unmounted).
/// An unknown path is a no-op.
#[tauri::command]
pub fn project_fs_unwatch(watchers: State<ProjectFsWatchers>, path: String) {
    watchers.0.remove(&path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A unique temp root per test (std-only; no tempfile dependency), matching
    /// `plugins_fs`'s test convention.
    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kd-project-fs-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &PathBuf, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn roots(root: &PathBuf) -> Vec<String> {
        vec![root.to_string_lossy().into_owned()]
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

    // ---- watching ----

    #[test]
    fn structural_change_excludes_content_and_access() {
        use notify::event::{AccessKind, CreateKind, DataChange, ModifyKind, RemoveKind};
        assert!(is_structural_change(&Event::new(EventKind::Create(CreateKind::File))));
        assert!(is_structural_change(&Event::new(EventKind::Remove(RemoveKind::File))));
        // A content write must NOT count — else an actively-written file spams
        // the tree with re-reads.
        assert!(!is_structural_change(&Event::new(EventKind::Modify(
            ModifyKind::Data(DataChange::Content)
        ))));
        assert!(!is_structural_change(&Event::new(EventKind::Access(AccessKind::Read))));
    }

    #[test]
    fn project_watch_delivers_the_registered_path_on_a_child_change() {
        let root = temp_root();
        let (tx, rx) = mpsc::channel::<String>();
        let _watcher =
            spawn_project_watch(&root, "ui-key".to_string(), move |registered| {
                let _ = tx.send(registered);
            })
            .expect("watch");

        fs::write(root.join("added.txt"), "x").unwrap();

        // fs delivery is async; a create may surface as several events — take
        // the first within the window, assert it carries the REGISTERED path.
        let got = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("a change within 10s");
        assert_eq!(got, "ui-key");
        fs::remove_dir_all(&root).ok();
    }
}
