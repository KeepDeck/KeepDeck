//! Reading PROJECT git state for the plugin `git` capability.
//!
//! The backend `services.git` lands on — the git sibling of [`crate::project_fs`]:
//! one repo's working-tree status ([`project_git_status`]), one path's unified
//! diff ([`project_git_diff_file`]), and a change watch ([`project_git_watch`])
//! so a changes view can follow the repo live instead of polling or asking the
//! user to refresh.
//!
//! Scope containment is [`crate::containment::resolve_within`], exactly like a
//! file read: the `git` capability's scope resolves to the same live roots, and
//! the repo path must sit inside one of them.
//!
//! Reads are pure by construction: everything runs under `--no-optional-locks`
//! (see `keepdeck-git`), so a status re-read can never take `index.lock` and
//! stall an agent's own git commands in the same worktree.
//!
//! ## The watch
//!
//! "The status changed" has TWO sources, so a watch registers two watchers:
//!
//! - the WORKING TREE, recursively — edits anywhere in it change status; on
//!   macOS this is one FSEvents stream per root, the OS walks the tree.
//!   Everything under a `.git` component is dropped here (lockfile churn,
//!   object writes — noise for status);
//! - the repo's private GITDIR, non-recursively — `index` (stage/unstage,
//!   commit), `HEAD` (checkout) and `refs` change status without touching the
//!   working tree. For a linked worktree the gitdir lives OUTSIDE the working
//!   tree (under the main repo's `.git/worktrees/<n>`), which is exactly why
//!   the recursive watcher alone would miss it.
//!
//! Delivery is throttled (leading edge, [`MIN_EVENT_GAP`]): a checkout or a
//! build can fire thousands of raw events in a burst, and the webview only
//! needs to learn "something changed" often enough for its own trailing
//! debounce to schedule one fresh status read.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use keepdeck_git::{diff, head, status};
use notify::{Event, EventKind, RecommendedWatcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::containment::resolve_within;
use crate::fswatch;

/// The Tauri event delivering "this repo's git status may have changed" to the
/// webview. Payload is [`ProjectGitChange`]; mirrored by `src/ipc/projectGit.ts`.
pub const PROJECT_GIT_CHANGE_EVENT: &str = "deck://project-git/change";

/// Minimum gap between two deliveries for one watched repo. Trailing-edge
/// correctness lives in the webview's debounce: whatever burst gets swallowed
/// here is picked up by the status read that follows the LAST delivered event.
const MIN_EVENT_GAP: Duration = Duration::from_millis(100);

/// One repo-changed notification. `path` is the repo AS REGISTERED by the
/// webview — its join key, never canonicalized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGitChange {
    pub path: String,
}

/// A working tree's status, as reported to the plugin. Mirrors
/// `keepdeck_git::RepoStatus` 1:1 — the crate type stays serde-free.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub detached: bool,
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub entries: Vec<GitStatusEntry>,
}

/// One changed path. `staged`/`unstaged` carry the porcelain v2 codes verbatim
/// (`'.'` = unchanged) — interpreting them is presentation logic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    pub staged: char,
    pub unstaged: char,
    pub untracked: bool,
    pub conflicted: bool,
}

impl From<keepdeck_git::RepoStatus> for GitStatus {
    fn from(st: keepdeck_git::RepoStatus) -> Self {
        GitStatus {
            branch: st.branch,
            detached: st.detached,
            oid: st.oid,
            upstream: st.upstream,
            ahead: st.ahead,
            behind: st.behind,
            entries: st
                .entries
                .into_iter()
                .map(|e| GitStatusEntry {
                    path: e.path,
                    orig_path: e.orig_path,
                    staged: e.staged,
                    unstaged: e.unstaged,
                    untracked: e.untracked,
                    conflicted: e.conflicted,
                })
                .collect(),
        }
    }
}

/// Read one repo's working-tree status.
///
/// `(async)` so the git subprocess runs on Tauri's worker pool, never the main
/// IPC thread (the `head_watch`/`project_fs` convention).
#[tauri::command(async)]
pub fn project_git_status(
    path: String,
    roots: Vec<String>,
    everywhere: bool,
) -> Result<GitStatus, String> {
    let repo = resolve_within(&path, &roots, everywhere)?;
    status::status(&repo).map(GitStatus::from).map_err(|e| e.to_string())
}

/// Unified diff for one tracked path in the repo — worktree vs index, or index
/// vs HEAD with `staged`. Untracked files have no diff (the plugin renders
/// their plain content via `services.fs` instead).
#[tauri::command(async)]
pub fn project_git_diff_file(
    path: String,
    roots: Vec<String>,
    everywhere: bool,
    file: String,
    staged: bool,
) -> Result<String, String> {
    let repo = resolve_within(&path, &roots, everywhere)?;
    diff::diff_file(&repo, &file, staged).map_err(|e| e.to_string())
}

/// The live git watchers — PAIRS of watchers (working tree + gitdir) keyed by
/// registered repo path. Tauri managed state; re-registering a path replaces
/// (and stops) the old pair, removing stops it.
#[derive(Default)]
pub struct ProjectGitWatchers(Mutex<HashMap<String, Vec<RecommendedWatcher>>>);

impl ProjectGitWatchers {
    fn insert(&self, key: String, watchers: Vec<RecommendedWatcher>) {
        self.lock().insert(key, watchers);
    }

    fn remove(&self, key: &str) {
        self.lock().remove(key);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<RecommendedWatcher>>> {
        self.0.lock().expect("git watch registry poisoned")
    }
}

/// Does a working-tree event matter to git status? Content writes DO (unlike
/// the file tree's structural filter — status is about bytes, not listings);
/// pure access never does; and anything under a `.git` component is the
/// gitdir's business, not the working tree's (for the main repo the `.git`
/// dir sits inside the watched root, so the recursive stream reports its
/// lockfile/object churn — all noise for status).
fn worktree_event_matters(event: &Event) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event
        .paths
        .iter()
        .any(|p| !p.components().any(|c| c.as_os_str() == ".git"))
}

/// Does a gitdir event matter to git status? `index` (stage/unstage/commit),
/// `HEAD` (checkout) and anything under `refs` do; lockfiles are the
/// mid-operation swap — the settled rename follows a moment later.
fn gitdir_event_matters(event: &Event) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event.paths.iter().any(|p| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.ends_with(".lock") {
            return false;
        }
        name == "index" || name == "HEAD" || p.components().any(|c| c.as_os_str() == "refs")
    })
}

/// Wire the two watchers for one repo, throttling delivery to one
/// notification per `min_gap`. Split from the command so the pipeline is
/// testable without a Tauri app.
fn spawn_git_watch(
    worktree: &Path,
    gitdir: &Path,
    registered: String,
    min_gap: Duration,
    deliver: impl Fn(String) + Send + Sync + 'static,
) -> Result<Vec<RecommendedWatcher>, String> {
    let deliver = Arc::new(deliver);
    // Primed in the past so the first real event always passes the throttle.
    let last_sent = Arc::new(Mutex::new(Instant::now() - min_gap));
    let notify = {
        let deliver = deliver.clone();
        move || {
            let mut last = last_sent.lock().expect("git watch throttle poisoned");
            if last.elapsed() >= min_gap {
                *last = Instant::now();
                deliver(registered.clone());
            }
        }
    };

    let tree_notify = notify.clone();
    let tree_watcher = fswatch::watch_dir_recursive(worktree, move |event| {
        if worktree_event_matters(event) {
            tree_notify();
        }
    })?;
    let gitdir_watcher = fswatch::watch_dir(gitdir, move |event| {
        if gitdir_event_matters(event) {
            notify();
        }
    })?;
    Ok(vec![tree_watcher, gitdir_watcher])
}

/// Start watching one repo for status-relevant changes, emitting
/// [`PROJECT_GIT_CHANGE_EVENT`]. Scoped exactly like a read. Idempotent per
/// registered path — re-registering replaces the old watcher pair.
#[tauri::command(async)]
pub fn project_git_watch(
    app: AppHandle,
    watchers: State<ProjectGitWatchers>,
    path: String,
    roots: Vec<String>,
    everywhere: bool,
) -> Result<(), String> {
    let repo = resolve_within(&path, &roots, everywhere)?;
    let gitdir = head::git_dir(&repo).map_err(|e| e.to_string())?;

    let emitter = app.clone();
    let pair = spawn_git_watch(&repo, &gitdir, path.clone(), MIN_EVENT_GAP, move |registered| {
        let _ = emitter.emit(PROJECT_GIT_CHANGE_EVENT, &ProjectGitChange { path: registered });
    })?;
    watchers.insert(path, pair);
    Ok(())
}

/// Stop watching a repo (tab switched away, workspace closed). An unknown path
/// is a no-op.
#[tauri::command]
pub fn project_git_unwatch(watchers: State<ProjectGitWatchers>, path: String) {
    watchers.remove(&path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, DataChange, ModifyKind};
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "kd-project-git-{label}-{}-{n}",
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
        fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    fn roots(root: &Path) -> Vec<String> {
        vec![root.to_string_lossy().into_owned()]
    }

    // ---- containment ----

    #[test]
    fn status_refuses_a_repo_outside_the_roots() {
        let repo = init_repo();
        let elsewhere = unique_dir("elsewhere");

        let err = project_git_status(
            repo.to_string_lossy().into_owned(),
            roots(&elsewhere),
            false,
        )
        .expect_err("outside the roots must be refused");
        assert!(err.contains("outside"), "unexpected error: {err}");

        fs::remove_dir_all(&repo).ok();
        fs::remove_dir_all(&elsewhere).ok();
    }

    #[test]
    fn empty_roots_authorize_nothing() {
        let repo = init_repo();
        let err = project_git_status(repo.to_string_lossy().into_owned(), vec![], false)
            .expect_err("empty workspace roots must refuse");
        assert!(err.contains("outside"), "unexpected error: {err}");
        fs::remove_dir_all(&repo).ok();
    }

    // ---- status + diff over IPC-shaped calls ----

    #[test]
    fn status_and_diff_round_trip() {
        let repo = init_repo();
        fs::write(repo.join("README.md"), "changed\n").unwrap();

        let st = project_git_status(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
        )
        .expect("status");
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.entries.len(), 1);
        assert_eq!(st.entries[0].path, "README.md");
        assert_eq!(st.entries[0].unstaged, 'M');

        let diff = project_git_diff_file(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            "README.md".to_string(),
            false,
        )
        .expect("diff");
        assert!(diff.contains("-hello"));
        assert!(diff.contains("+changed"));

        fs::remove_dir_all(&repo).ok();
    }

    // ---- event filters (pure) ----

    #[test]
    fn worktree_filter_keeps_content_edits_drops_git_and_access() {
        let edit = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
            .add_path(PathBuf::from("/ws/src/main.ts"));
        assert!(worktree_event_matters(&edit));

        let git_churn = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/ws/.git/objects/ab/cdef"));
        assert!(!worktree_event_matters(&git_churn));

        let access = Event::new(EventKind::Access(AccessKind::Any))
            .add_path(PathBuf::from("/ws/src/main.ts"));
        assert!(!worktree_event_matters(&access));
    }

    #[test]
    fn gitdir_filter_keeps_index_head_refs_drops_locks() {
        let index = Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(PathBuf::from("/repo/.git/index"));
        assert!(gitdir_event_matters(&index));

        let head = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/repo/.git/HEAD"));
        assert!(gitdir_event_matters(&head));

        let reflog = Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(PathBuf::from("/repo/.git/refs/heads/main"));
        assert!(gitdir_event_matters(&reflog));

        let lock = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/repo/.git/index.lock"));
        assert!(!gitdir_event_matters(&lock));

        let editmsg = Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(PathBuf::from("/repo/.git/COMMIT_EDITMSG"));
        assert!(!gitdir_event_matters(&editmsg));
    }

    // ---- watch pipeline end-to-end ----

    #[test]
    fn watch_delivers_worktree_edits_and_index_changes() {
        let repo = init_repo();
        let gitdir = head::git_dir(&repo).unwrap();
        let (tx, rx) = mpsc::channel::<String>();

        let _pair = spawn_git_watch(
            &repo,
            &gitdir,
            "ui-key".to_string(),
            Duration::ZERO, // no throttle in tests — assert every delivery
            move |key| {
                let _ = tx.send(key);
            },
        )
        .expect("watch");

        // A working-tree edit reaches the webview…
        fs::write(repo.join("README.md"), "edited\n").unwrap();
        let key = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("an event for the edit");
        assert_eq!(key, "ui-key");
        while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}

        // …and so does a pure index change (stage without editing anything).
        git(&repo, &["add", "README.md"]);
        rx.recv_timeout(Duration::from_secs(10))
            .expect("an event for the staging");

        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn throttle_swallows_a_burst() {
        let repo = init_repo();
        let gitdir = head::git_dir(&repo).unwrap();
        let (tx, rx) = mpsc::channel::<String>();

        let _pair = spawn_git_watch(
            &repo,
            &gitdir,
            "k".to_string(),
            Duration::from_secs(3600), // one delivery, then the gate closes
            move |key| {
                let _ = tx.send(key);
            },
        )
        .expect("watch");

        for n in 0..20 {
            fs::write(repo.join(format!("burst-{n}.txt")), "x").unwrap();
        }

        rx.recv_timeout(Duration::from_secs(10))
            .expect("the burst's first delivery");
        assert!(
            rx.recv_timeout(Duration::from_millis(500)).is_err(),
            "everything after the first delivery must be throttled"
        );

        fs::remove_dir_all(&repo).ok();
    }
}
