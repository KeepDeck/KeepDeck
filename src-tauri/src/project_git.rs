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
//! "The repo changed" has several sources, so a watch registers a SET:
//!
//! - the WORKING TREE, recursively — edits anywhere in it change status; on
//!   macOS this is one FSEvents stream per root, the OS walks the tree.
//!   Everything under a `.git` component is dropped here (lockfile churn,
//!   object writes — noise for status);
//! - the repo's private GITDIR, non-recursively — `index` (stage/unstage,
//!   commit), `HEAD` (checkout) and `packed-refs` change state without
//!   touching the working tree. For a linked worktree the gitdir lives
//!   OUTSIDE the working tree (under the main repo's `.git/worktrees/<n>`),
//!   which is exactly why the recursive watcher alone would miss it;
//! - the COMMON gitdir's `refs/`, recursively — branches are SHARED state: a
//!   fetch, reset or merge in another checkout moves a ref without touching
//!   this worktree at all. For linked worktrees the common dir itself is
//!   watched too (packed-refs swaps from gc/pack-refs); the main checkout's
//!   gitdir watcher already covers that file.
//!
//! Delivery is throttled (leading edge, [`MIN_EVENT_GAP`]): a checkout or a
//! build can fire thousands of raw events in a burst, and the webview only
//! needs to learn "something changed" often enough for its own trailing
//! debounce to schedule one fresh status read.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use keepdeck_git::{diff, head, log, repo, status};
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

/// Unified diff for one tracked path in the repo. Three shapes, one command:
/// worktree vs index (default), index vs HEAD (`staged`), or across a
/// revision range when `from` is given (`from..to`, or `from` against the
/// working tree without `to`). Untracked files have no diff (the plugin
/// renders their plain content via `services.fs` instead).
#[tauri::command(async)]
pub fn project_git_diff_file(
    path: String,
    roots: Vec<String>,
    everywhere: bool,
    file: String,
    staged: bool,
    from: Option<String>,
    to: Option<String>,
) -> Result<String, String> {
    let repo = resolve_within(&path, &roots, everywhere)?;
    match from {
        Some(from) => {
            let from = commit_or_root(&repo, &from);
            diff::diff_file_range(&repo, &file, &from, to.as_deref())
        }
        None => diff::diff_file(&repo, &file, staged),
    }
    .map_err(|e| e.to_string())
}

/// One commit as reported to the plugin. Mirrors `keepdeck_git::Commit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub sha: String,
    pub author: String,
    pub timestamp: i64,
    pub subject: String,
}

/// A branch's history: the FULL recent log (capped), annotated with its fork
/// point so a UI can draw the boundary between the branch's own commits and
/// the base history beneath them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistory {
    /// The fork point commit; `None` when there is no meaningful one (the
    /// repo IS on the base branch, no base resolves, or no common ancestor).
    pub fork_sha: Option<String>,
    /// Commits on the branch's own side of the fork — honest even when the
    /// fork sits beyond the listing cap. `None` without a fork.
    pub ahead: Option<u32>,
    /// Recent commits from `HEAD`, newest first, capped — the branch's own
    /// commits first, then the fork commit and the base history below it.
    pub commits: Vec<GitCommit>,
}

/// The default page the webview asks for, and the hard ceiling one read may
/// request — lazy scrolling grows the ask in [`HISTORY_CHUNK`]-sized steps,
/// and even a runaway caller can't flood the webview past the ceiling.
const HISTORY_CHUNK: usize = 50;
const HISTORY_MAX: usize = 10_000;

/// A repo's history for the changes view: the recent log (newest first, up to
/// `limit`, clamped), annotated with the fork point off `base` (defaulting to
/// the repo's default branch — exact for worktrees created off it).
#[tauri::command(async)]
pub fn project_git_history(
    path: String,
    roots: Vec<String>,
    everywhere: bool,
    base: Option<String>,
    limit: Option<u32>,
    rev: Option<String>,
) -> Result<GitHistory, String> {
    let repo = resolve_within(&path, &roots, everywhere)?;

    // `rev` lets the UI browse ANY ref's history without a checkout; absent,
    // the walk starts at the working tree's own HEAD.
    let rev = rev.as_deref().unwrap_or("HEAD");
    let tip = repo::resolve_commit(&repo, rev).map_err(|e| e.to_string())?;

    // The fork-point ladder:
    // 1. an EXPLICIT base wins — merge-base against it, as asked;
    // 2. else the branch's own reflog: git recorded the creation commit when
    //    the branch was cut, which is the exact fork even for a worktree made
    //    off a picked base (the default-branch guess would misjudge that);
    // 3. else merge-base against the repo's default branch.
    // A fork AT the tip means "this ref IS the base" — nothing to measure.
    let default = repo::default_branch(&repo).unwrap_or(None);
    let branch_name = if rev == "HEAD" {
        repo::current_branch(&repo).unwrap_or(None)
    } else {
        Some(rev.to_string())
    };
    let fork = match base {
        Some(ref base_ref) => repo::merge_base(&repo, base_ref, rev)
            .map_err(|e| e.to_string())?
            .filter(|fork| fork != &tip),
        // No explicit base: measure against the repo's default branch — but
        // only if one resolves. Without it (a local-only `git init`, or a repo
        // whose only remote isn't `origin`) there is no base branch, so there
        // is nothing this ref could have forked FROM, and every rung of the
        // ladder needs a base to mean anything. Measuring anyway would reach
        // the reflog and take the branch's creation entry, which in a repo
        // with no base IS its first commit — an ancestor of the tip and not
        // the tip, so it clears both guards and draws the branch as forked
        // from its own root.
        None => match default.as_deref() {
            None => None,
            Some(base_ref) => {
                let from_reflog = branch_name
                    // The default branch's creation entry is its clone point —
                    // meaningless as a fork; the base branch has no base.
                    .filter(|name| name != base_ref)
                    .and_then(|name| repo::branch_created_at(&repo, &name).ok().flatten())
                    .filter(|created| created != &tip)
                    // A rebase orphans the creation point — only an ancestor
                    // of the tip still describes this branch's history.
                    .filter(|created| {
                        repo::merge_base(&repo, created, &tip).ok().flatten().as_deref()
                            == Some(created.as_str())
                    });
                match from_reflog {
                    Some(created) => Some(created),
                    None => repo::merge_base(&repo, base_ref, rev)
                        .map_err(|e| e.to_string())?
                        .filter(|fork| fork != &tip),
                }
            }
        },
    };

    // The FULL recent log — the ref's own commits arrive first (newest-first
    // order), then the fork commit and the base history; the fork sha lets
    // the UI draw the boundary. `ahead` is counted separately so it stays
    // honest whatever window the UI has scrolled to.
    let limit = (limit.unwrap_or(HISTORY_CHUNK as u32) as usize).clamp(1, HISTORY_MAX);
    let commits = log::log(&repo, Some(rev), limit).map_err(|e| e.to_string())?;
    let ahead = match &fork {
        Some(fork) => Some(
            log::count_range(&repo, &format!("{fork}..{rev}")).map_err(|e| e.to_string())?,
        ),
        None => None,
    };

    Ok(GitHistory {
        fork_sha: fork,
        ahead,
        commits: commits
            .into_iter()
            .map(|c| GitCommit {
                sha: c.sha,
                author: c.author,
                timestamp: c.timestamp,
                subject: c.subject,
            })
            .collect(),
    })
}

/// A repo's local branches, for the history browser's ref picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    /// The branch the working tree is on; `None` when detached.
    pub current: Option<String>,
    /// Local branch names, alphabetical. Remote-tracking refs are excluded —
    /// browsing history is a LOCAL affair, same rule as the base-branch picker.
    pub branches: Vec<String>,
}

/// List the repo's local branches and which one is checked out.
#[tauri::command(async)]
pub fn project_git_branches(
    path: String,
    roots: Vec<String>,
    everywhere: bool,
) -> Result<GitBranches, String> {
    let repo = resolve_within(&path, &roots, everywhere)?;
    Ok(GitBranches {
        current: repo::current_branch(&repo).map_err(|e| e.to_string())?,
        branches: repo::list_branches(&repo).map_err(|e| e.to_string())?,
    })
}

/// One changed path across a revision range, as reported to the plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub orig_path: Option<String>,
    pub code: char,
}

/// The paths changed across `from..to` (or `from` vs the working tree without
/// `to`) — the file list behind a commit row or the "since fork" summary.
#[tauri::command(async)]
pub fn project_git_changed_files(
    path: String,
    roots: Vec<String>,
    everywhere: bool,
    from: String,
    to: Option<String>,
) -> Result<Vec<GitChangedFile>, String> {
    let repo = resolve_within(&path, &roots, everywhere)?;
    let from = commit_or_root(&repo, &from);
    diff::changed_files(&repo, &from, to.as_deref())
        .map(|files| {
            files
                .into_iter()
                .map(|f| GitChangedFile {
                    path: f.path,
                    orig_path: f.orig_path,
                    code: f.code,
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

/// Git's well-known empty-tree object — what a root commit's "parent" diffs
/// against.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Resolve a `from` revision, degrading an unresolvable `<sha>^` (a ROOT
/// commit's parent, which doesn't exist) to the empty tree so the root
/// commit's own diff still renders instead of erroring.
fn commit_or_root(repo: &Path, from: &str) -> String {
    if repo::resolve_commit(repo, from).is_ok() {
        from.to_string()
    } else {
        EMPTY_TREE.to_string()
    }
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
        name == "index"
            || name == "HEAD"
            || name == "packed-refs"
            || p.components().any(|c| c.as_os_str() == "refs")
    })
}

/// Does a shared-refs event matter? Anything but pure access and lockfile
/// churn — a loose ref written, moved or deleted at any depth under `refs/`
/// is a branch moving.
fn refs_event_matters(event: &Event) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event.paths.iter().any(|p| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        !name.ends_with(".lock")
    })
}

/// Wire the two watchers for one repo, throttling delivery to one
/// notification per `min_gap`. Split from the command so the pipeline is
/// testable without a Tauri app.
fn spawn_git_watch(
    worktree: &Path,
    gitdir: &Path,
    common_dir: &Path,
    registered: String,
    min_gap: Duration,
    deliver: impl Fn(String) + Send + Sync + 'static,
) -> Result<Vec<RecommendedWatcher>, String> {
    let deliver = Arc::new(deliver);
    // Primed in the past so the first real event always passes the throttle.
    let last_sent = Arc::new(Mutex::new(Instant::now() - min_gap));
    // A plain closure: its captures are Arcs, so it clones per watcher.
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
    let gitdir_notify = notify.clone();
    let gitdir_watcher = fswatch::watch_dir(gitdir, move |event| {
        if gitdir_event_matters(event) {
            gitdir_notify();
        }
    })?;
    let mut watchers = vec![tree_watcher, gitdir_watcher];

    // SHARED refs live in the COMMON gitdir — a branch moved from another
    // checkout (a fetch, a reset, a merge elsewhere) touches nothing the two
    // watchers above can see. Recursive: loose refs nest (`refs/heads/kd/…`),
    // and the gitdir watcher above is deliberately non-recursive.
    let refs_notify = notify.clone();
    watchers.push(fswatch::watch_dir_recursive(
        &common_dir.join("refs"),
        move |event| {
            if refs_event_matters(event) {
                refs_notify();
            }
        },
    )?);

    // A linked worktree's private gitdir is NOT the common one — watch the
    // common dir too, for the `packed-refs` swaps (gc/pack-refs) that replace
    // loose refs without touching `refs/`. The main checkout's own gitdir
    // watcher already covers this (same directory).
    if common_dir != gitdir {
        let common_notify = notify.clone();
        watchers.push(fswatch::watch_dir(common_dir, move |event| {
            if gitdir_event_matters(event) {
                common_notify();
            }
        })?);
    }
    Ok(watchers)
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
    let common = head::git_common_dir(&repo).map_err(|e| e.to_string())?;

    let emitter = app.clone();
    let set = spawn_git_watch(
        &repo,
        &gitdir,
        &common,
        path.clone(),
        MIN_EVENT_GAP,
        move |registered| {
            let _ = emitter.emit(PROJECT_GIT_CHANGE_EVENT, &ProjectGitChange { path: registered });
        },
    )?;
    watchers.insert(path, set);
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
            None,
            None,
        )
        .expect("diff");
        assert!(diff.contains("-hello"));
        assert!(diff.contains("+changed"));

        fs::remove_dir_all(&repo).ok();
    }

    // ---- history over IPC-shaped calls ----

    /// Give the repo a fake `origin/main` at the CURRENT head so
    /// `default_branch` resolves (the fork-point default) without a network.
    fn fake_origin_main_here(repo: &Path) {
        git(repo, &["config", "remote.origin.url", "."]);
        git(
            repo,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
        );
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);
        git(
            repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
    }

    #[test]
    fn history_measures_a_branch_from_its_fork_point() {
        let repo = init_repo();
        fake_origin_main_here(&repo);

        // Fork a branch and commit twice; one uncommitted edit on top.
        git(&repo, &["checkout", "-q", "-b", "kd/test/1"]);
        fs::write(repo.join("a.ts"), "a\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "first"]);
        fs::write(repo.join("b.ts"), "b\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "second"]);
        fs::write(repo.join("README.md"), "dirty\n").unwrap();

        let history = project_git_history(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            None, // base defaults to the repo's default branch
            None, // default page size
            None, // the working tree's own HEAD
        )
        .expect("history");

        // A one-commit window still counts the branch's full side honestly.
        let windowed = project_git_history(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            None,
            Some(1),
            None,
        )
        .expect("windowed history");
        assert_eq!(windowed.commits.len(), 1);
        assert_eq!(windowed.ahead, Some(2));

        let fork = history.fork_sha.expect("a fork point");
        assert_eq!(fork.len(), 40);
        assert_eq!(history.ahead, Some(2), "branch commits counted honestly");
        // The FULL log: branch commits first, then the fork commit (init).
        assert_eq!(history.commits.len(), 3);
        assert_eq!(history.commits[0].subject, "second");
        assert_eq!(history.commits[1].subject, "first");
        assert_eq!(history.commits[2].subject, "init");
        assert_eq!(history.commits[2].sha, fork, "the fork commit is listed — the UI's boundary");

        // The since-fork file list vs the WORKING TREE includes the dirty edit.
        let files = project_git_changed_files(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            fork,
            None,
        )
        .expect("changed files");
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.ts"), "{paths:?}");
        assert!(paths.contains(&"b.ts"), "{paths:?}");
        assert!(paths.contains(&"README.md"), "{paths:?}");

        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn history_browses_a_ref_without_a_checkout() {
        let repo = init_repo();
        fake_origin_main_here(&repo);

        // A branch with one commit — then BACK to main, so the ref under
        // inspection is not checked out anywhere.
        git(&repo, &["checkout", "-q", "-b", "kd/test/2"]);
        fs::write(repo.join("side.ts"), "s\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "side work"]);
        git(&repo, &["checkout", "-q", "main"]);

        let history = project_git_history(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            None,
            None,
            Some("kd/test/2".to_string()),
        )
        .expect("history of a foreign ref");

        assert_eq!(history.ahead, Some(1));
        assert_eq!(history.commits[0].subject, "side work");
        assert!(history.fork_sha.is_some());

        let listed = project_git_branches(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
        )
        .expect("branches");
        assert_eq!(listed.current.as_deref(), Some("main"));
        assert!(listed.branches.contains(&"kd/test/2".to_string()));

        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn fork_comes_from_the_reflog_for_a_picked_base() {
        let repo = init_repo();
        fake_origin_main_here(&repo);

        // A picked base: a feature branch one commit past main…
        git(&repo, &["checkout", "-q", "-b", "base-feat"]);
        fs::write(repo.join("base.ts"), "b\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "base work"]);
        let base_tip = keepdeck_git::repo::resolve_commit(&repo, "HEAD").unwrap();

        // …and an agent branch cut FROM it, one commit of its own.
        git(&repo, &["checkout", "-q", "-b", "kd/picked/1"]);
        fs::write(repo.join("own.ts"), "o\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "own work"]);

        let history = project_git_history(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            None,
            None,
            None,
        )
        .expect("history");

        // The default-branch heuristic would blame the base's commit on the
        // agent (fork at main, ahead 2). The reflog knows better.
        assert_eq!(history.fork_sha.as_deref(), Some(base_tip.as_str()));
        assert_eq!(history.ahead, Some(1));
        assert_eq!(history.commits[0].subject, "own work");

        // A rebase orphans the creation point — the ladder falls back to the
        // default-branch heuristic instead of measuring from a non-ancestor.
        // Main must move first: rebasing onto an ancestor is a no-op.
        git(&repo, &["checkout", "-q", "main"]);
        fs::write(repo.join("mainline.ts"), "m\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "mainline moves"]);
        git(&repo, &["checkout", "-q", "kd/picked/1"]);
        git(&repo, &["rebase", "-q", "main"]);
        let rebased = project_git_history(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            None,
            None,
            None,
        )
        .expect("history after rebase");
        let main_sha = keepdeck_git::repo::resolve_commit(&repo, "main").unwrap();
        assert_eq!(rebased.fork_sha.as_deref(), Some(main_sha.as_str()));
        assert_eq!(rebased.ahead, Some(2), "base+own commits, both rebased");

        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn history_on_the_base_branch_is_plain_recent_log() {
        let repo = init_repo();
        fake_origin_main_here(&repo);

        // Still ON main: merge-base(main, HEAD) == HEAD → no fork to measure.
        let history = project_git_history(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            None,
            None,
            None,
        )
        .expect("history");

        assert_eq!(history.fork_sha, None);
        assert_eq!(history.ahead, None);
        assert_eq!(history.commits.len(), 1, "the init commit");
        assert_eq!(history.commits[0].subject, "init");

        fs::remove_dir_all(&repo).ok();
    }

    /// A local-only repo (no `fake_origin_main_here`, so no `origin/HEAD`)
    /// has no default branch — and therefore no base anything could have
    /// forked from. The reflog rung must not fire: a branch's creation entry
    /// here IS the repo's first commit, which is an ancestor of the tip and
    /// not the tip, so it clears both guards and would be reported as a fork
    /// point above the initial commit — the branch forked from its own root.
    #[test]
    fn history_measures_no_fork_when_no_default_branch_resolves() {
        let repo = init_repo();
        git(&repo, &["checkout", "-q", "-b", "feature"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "work"]);

        let history = project_git_history(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            None,
            None,
            None,
        )
        .expect("history");

        assert_eq!(history.fork_sha, None, "no base branch means no fork");
        assert_eq!(history.ahead, None, "nothing to be ahead OF");
        assert_eq!(history.commits.len(), 2);

        fs::remove_dir_all(&repo).ok();
    }

    /// An EXPLICIT base is a real base — it doesn't depend on `origin/HEAD`
    /// resolving, so the arm above must not swallow it.
    #[test]
    fn history_still_measures_an_explicit_base_without_a_default_branch() {
        let repo = init_repo();
        let root = keepdeck_git::repo::resolve_commit(&repo, "HEAD").unwrap();
        git(&repo, &["checkout", "-q", "-b", "feature"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "work"]);

        let history = project_git_history(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            Some("main".to_string()),
            None,
            None,
        )
        .expect("history");

        assert_eq!(history.fork_sha, Some(root));
        assert_eq!(history.ahead, Some(1));

        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn a_root_commits_parent_degrades_to_the_empty_tree() {
        let repo = init_repo();
        let head = keepdeck_git::repo::resolve_commit(&repo, "HEAD").unwrap();

        // `<root>^` resolves to nothing; the diff must still render the root
        // commit's own content instead of erroring.
        let files = project_git_changed_files(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            format!("{head}^"),
            Some(head.clone()),
        )
        .expect("root-commit files");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].code, 'A');
        assert_eq!(files[0].path, "README.md");

        let diff = project_git_diff_file(
            repo.to_string_lossy().into_owned(),
            roots(&repo),
            false,
            "README.md".to_string(),
            false,
            Some(format!("{head}^")),
            Some(head),
        )
        .expect("root-commit diff");
        assert!(diff.contains("+hello"), "{diff}");

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

        let common = head::git_common_dir(&repo).unwrap();
        let _set = spawn_git_watch(
            &repo,
            &gitdir,
            &common,
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
    fn refs_filter_keeps_ref_writes_drops_locks_and_access() {
        let loose = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/repo/.git/refs/heads/kd/app/1"));
        assert!(refs_event_matters(&loose));

        let lock = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/repo/.git/refs/heads/main.lock"));
        assert!(!refs_event_matters(&lock));

        let access = Event::new(EventKind::Access(AccessKind::Any))
            .add_path(PathBuf::from("/repo/.git/refs/heads/main"));
        assert!(!refs_event_matters(&access));
    }

    #[test]
    fn gitdir_filter_accepts_packed_refs() {
        let packed = Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(PathBuf::from("/repo/.git/packed-refs"));
        assert!(gitdir_event_matters(&packed));
    }

    #[test]
    fn watch_sees_branch_moves_made_outside_the_watched_worktree() {
        let repo = init_repo();
        let base = keepdeck_git::repo::resolve_commit(&repo, "HEAD").unwrap();

        // A linked worktree — the thing a pane actually watches.
        let wt = repo.parent().unwrap().join(format!(
            "kd-wt-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        keepdeck_git::worktree::add(&repo, &wt, "kd/watch/1", &base).expect("add worktree");

        let gitdir = head::git_dir(&wt).unwrap();
        let common = head::git_common_dir(&wt).unwrap();
        assert_ne!(gitdir, common, "a linked worktree splits the two");

        let (tx, rx) = mpsc::channel::<String>();
        let _set = spawn_git_watch(&wt, &gitdir, &common, "wt".to_string(), Duration::ZERO, {
            move |key| {
                let _ = tx.send(key);
            }
        })
        .expect("watch");

        // A branch moved IN THE MAIN REPO — nothing in the worktree's own
        // tree or private gitdir changes, only the shared refs.
        git(&repo, &["branch", "outside-news"]);
        rx.recv_timeout(Duration::from_secs(10))
            .expect("a shared-ref event within 10s");
        while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}

        // Packing the refs replaces loose files with one packed-refs swap —
        // the common-dir watcher must still deliver.
        git(&repo, &["pack-refs", "--all"]);
        rx.recv_timeout(Duration::from_secs(10))
            .expect("a packed-refs event within 10s");

        fs::remove_dir_all(&wt).ok();
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn throttle_swallows_a_burst() {
        let repo = init_repo();
        let gitdir = head::git_dir(&repo).unwrap();
        let (tx, rx) = mpsc::channel::<String>();

        let common = head::git_common_dir(&repo).unwrap();
        let _set = spawn_git_watch(
            &repo,
            &gitdir,
            &common,
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
