//! Watching project directories for LISTING changes.
//!
//! The other half of the `fs` capability's backend: reading answers "what is
//! in this directory NOW", this keeps the answer fresh. Scoped exactly like a
//! read — a directory a plugin may list is a directory it may watch, by the
//! same path string and through the same containment check.

use std::path::Path;

use notify::{Event, EventKind};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::containment::{expand_home, resolve_within};
use crate::fswatch;

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
    // Same `~/` expansion as its read siblings — a dir a plugin can readDir
    // must also be watchable by the same path string.
    let dir = resolve_within(&expand_home(&path)?, &roots, everywhere)?;
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
    use crate::project_fs::testing::temp_root;
    use std::fs;
    use std::sync::mpsc;
    use std::time::Duration;

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
