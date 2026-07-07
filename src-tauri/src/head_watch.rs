//! Live branch badge — per-worktree `HEAD` watchers.
//!
//! A pane's badge shows the branch its worktree is ON, not the one it was
//! created with: a `git checkout` inside the worktree (by the agent, or the
//! user in a terminal) must reach the UI. The signal is the worktree's private
//! gitdir: checkout rewrites its `HEAD` file, the `notify` watcher here sees
//! it, re-reads the file and emits `deck://worktree/head` to the webview.
//!
//! Two deliberate choices:
//! - The gitdir DIRECTORY is watched (non-recursively), not the `HEAD` file:
//!   git replaces `HEAD` via lockfile + rename, and a watch on the file's
//!   inode would silently die at the first rename.
//! - Registration immediately emits the current state, so a branch switched
//!   while KeepDeck wasn't running reconciles at startup for free — the
//!   webview re-registers watches on every boot.
//!
//! Watching is passive (FSEvents/inotify subscriptions hold no handle on the
//! file), so git, agents and the user are never blocked or slowed.

use std::path::{Path, PathBuf};

use keepdeck_git::head::{self, Head};
use notify::{Event, EventKind};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::fswatch::{self, WatchRegistry};

/// Event delivering one worktree's current HEAD (see `src/ipc/worktree.ts`).
pub const WORKTREE_HEAD_EVENT: &str = "deck://worktree/head";

/// What the webview learns: the worktree is either on a branch or detached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadEvent {
    /// The worktree path AS REGISTERED by the webview — its join key back to
    /// the pane, so it is never canonicalized or otherwise rewritten.
    pub path: String,
    /// Short branch name; `None` when detached.
    pub branch: Option<String>,
    /// The commit SHA when detached; `None` on a branch.
    pub head: Option<String>,
}

/// The live worktree HEAD watchers — a shared [`WatchRegistry`] keyed by
/// registered worktree path. Tauri managed state; dropping an entry stops it.
#[derive(Default)]
pub struct HeadWatchers(WatchRegistry);

/// Read the worktree's current HEAD into an event. `None` means a transient
/// mid-checkout state (lockfile swap) — skipped, the rename's own fs event
/// re-reads the settled file a moment later.
fn head_event(path: &str, gitdir: &Path) -> Option<HeadEvent> {
    let (branch, head) = match head::read_head(gitdir)? {
        Head::Branch(name) => (Some(name), None),
        Head::Detached(sha) => (None, Some(sha)),
    };
    Some(HeadEvent {
        path: path.to_string(),
        branch,
        head,
    })
}

/// Is this fs event about the `HEAD` file itself? The watched gitdir also
/// churns `index`, `ORIG_HEAD`, lockfiles — noise here.
fn is_head_event(event: &Event) -> bool {
    matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_))
        && event
            .paths
            .iter()
            .any(|p| p.file_name().is_some_and(|n| n == "HEAD"))
}

/// Start a watcher over `gitdir` that delivers a fresh [`HeadEvent`] whenever
/// the worktree's `HEAD` changes. Delivery is a plain closure so the pipeline
/// is testable without a Tauri app handle.
fn spawn_watcher(
    path: String,
    gitdir: PathBuf,
    deliver: impl Fn(HeadEvent) + Send + 'static,
) -> Result<notify::RecommendedWatcher, String> {
    let watched = gitdir.clone();
    fswatch::watch_dir(&gitdir, move |event| {
        if !is_head_event(event) {
            return;
        }
        if let Some(payload) = head_event(&path, &watched) {
            deliver(payload);
        }
    })
}

/// Watch one worktree's HEAD, emitting its current state right away.
/// Idempotent per path: re-registering replaces (and stops) the old watcher.
///
/// `(async)` so the `git rev-parse` in `head::git_dir` runs on Tauri's worker
/// pool — a deck with N worktree panes registers N watches on boot, and those
/// serial subprocesses must not stall the main IPC thread.
#[tauri::command(async)]
pub fn worktree_watch(
    app: AppHandle,
    watchers: State<HeadWatchers>,
    path: String,
) -> Result<(), String> {
    let gitdir = head::git_dir(Path::new(&path)).map_err(|e| e.to_string())?;

    if let Some(event) = head_event(&path, &gitdir) {
        let _ = app.emit(WORKTREE_HEAD_EVENT, &event);
    }

    let emitter = app.clone();
    let watcher = spawn_watcher(path.clone(), gitdir, move |payload| {
        let _ = emitter.emit(WORKTREE_HEAD_EVENT, &payload);
    })?;

    watchers.0.insert(path, watcher);
    Ok(())
}

/// Stop watching a worktree (pane closed / workspace gone). Unknown paths are
/// a no-op — the close flow may race a failed registration.
#[tauri::command]
pub fn worktree_unwatch(watchers: State<HeadWatchers>, path: String) {
    watchers.0.remove(&path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};
    use std::fs;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "keepdeck-headwatch-{label}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed in {}", dir.display());
    }

    fn init_repo() -> PathBuf {
        let dir = unique_dir("repo");
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "test@keepdeck.ai"]);
        git(&dir, &["config", "user.name", "KeepDeck Test"]);
        fs::write(dir.join("README.md"), "hello").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn head_event_reports_branch_and_detached() {
        let repo = init_repo();
        let gitdir = head::git_dir(&repo).unwrap();

        let on_branch = head_event("/ui/key", &gitdir).expect("event");
        assert_eq!(on_branch.path, "/ui/key"); // the UI's key, not the fs path
        assert_eq!(on_branch.branch.as_deref(), Some("main"));
        assert_eq!(on_branch.head, None);

        git(&repo, &["checkout", "-q", "--detach"]);
        let detached = head_event("/ui/key", &gitdir).expect("event");
        assert_eq!(detached.branch, None);
        assert!(detached.head.is_some_and(|sha| sha.len() >= 40));

        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn filters_events_to_head_files_only() {
        let head_file = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/x/.git/HEAD"));
        assert!(is_head_event(&head_file));

        let index = Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(PathBuf::from("/x/.git/index"));
        assert!(!is_head_event(&index));

        // A HEAD removal is half of the lockfile swap — only the settled
        // create/modify should trigger a read.
        let removal = Event::new(EventKind::Remove(RemoveKind::File))
            .add_path(PathBuf::from("/x/.git/HEAD"));
        assert!(!is_head_event(&removal));
    }

    #[test]
    fn watcher_delivers_checkouts_end_to_end() {
        let repo = init_repo();
        let gitdir = head::git_dir(&repo).unwrap();
        let (tx, rx) = mpsc::channel::<HeadEvent>();

        let _watcher = spawn_watcher(repo.to_string_lossy().into_owned(), gitdir, move |e| {
            let _ = tx.send(e);
        })
        .expect("watch");

        git(&repo, &["checkout", "-q", "-b", "kd/live/1"]);

        // fs event delivery is async; take the LAST event within the window
        // (a checkout may surface several HEAD-touching events).
        let mut last = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("a head event within 10s");
        while let Ok(more) = rx.recv_timeout(Duration::from_millis(300)) {
            last = more;
        }
        assert_eq!(last.branch.as_deref(), Some("kd/live/1"));

        fs::remove_dir_all(&repo).ok();
    }
}
