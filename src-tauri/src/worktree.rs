//! Worktree delivery layer: bridges the `keepdeck-git` domain crate to the
//! webview over Tauri IPC.
//!
//! Clean-architecture boundary — this adapter depends on `keepdeck-git`, never
//! the reverse. It exposes the `worktree_*` commands the UI calls to provision
//! and tear down each agent's git worktree, and owns a [`RepoLocks`] map (Tauri
//! managed state) that serializes `git worktree add` per repository, since
//! concurrent adds race on the shared `.git` locks.
//!
//! Orchestration of WHEN to create/remove (the spawn/close flow) lives in the
//! frontend, which holds each agent's `worktreePath`/`branch`; these commands
//! are the stateless primitives it drives.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use keepdeck_git::{branch, repo, worktree};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Per-repository locks that serialize `git worktree add`. Tauri managed state.
///
/// Two agents spawning at once would otherwise race on the repo's `.git`
/// config/ref locks; we hold the repo's lock across the add so they queue.
#[derive(Default)]
pub struct RepoLocks {
    inner: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl RepoLocks {
    /// The lock for `repo`, created on first use. Keyed by the canonical path so
    /// different spellings of the same repo share one lock.
    fn for_repo(&self, repo: &Path) -> Arc<Mutex<()>> {
        let key = std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf());
        self.inner
            .lock()
            .expect("repo locks poisoned")
            .entry(key)
            .or_default()
            .clone()
    }
}

/// What the UI learns about a chosen working directory before spawning, to drive
/// the worktree nudge and to pin a base commit for the batch.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Whether the directory is inside a git work tree.
    pub is_repo: bool,
    /// The current `HEAD` commit SHA, when it is a repo.
    pub head: Option<String>,
    /// The current branch, or `None` if detached / not a repo.
    pub branch: Option<String>,
}

/// Request to create one agent's worktree.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSpec {
    /// The repository (the workspace's working directory).
    pub repo: String,
    /// Base folder under which this workspace's agent worktrees live.
    pub base_dir: String,
    /// Stable agent id — the record key tying the worktree back to its agent.
    pub agent_id: String,
    /// Explicit branch name to create; auto-generated when absent/blank.
    pub branch: Option<String>,
    /// Pinned base commit/rev; defaults to `HEAD` resolved now.
    pub base: Option<String>,
    /// Workspace name, used only for the auto branch name.
    #[serde(default)]
    pub workspace: String,
    /// Agent index within the workspace, used only for the auto branch name.
    #[serde(default)]
    pub index: u64,
    /// Explicit worktree directory name (relative to `base_dir`); derived from
    /// the branch (slashes → dashes) when absent/blank.
    pub dir: Option<String>,
}

/// The created worktree, returned to the UI to store on the agent.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    pub agent_id: String,
    pub path: String,
    pub branch: String,
}

/// Request to remove an agent's worktree.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveSpec {
    pub repo: String,
    pub path: String,
    /// Remove even if the worktree is dirty. The UI sets this only on explicit
    /// intent; by default a dirty worktree is kept (work is never destroyed).
    #[serde(default)]
    pub force: bool,
}

/// Live status of a worktree, for the pane header and the close decision.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub dirty: bool,
    pub branch: Option<String>,
}

/// Pick the branch to create: an explicit non-blank name (sanitized per
/// component), else the auto `kd/<workspace>/<index>` default. Pure, unit-tested.
fn choose_branch(explicit: Option<&str>, workspace: &str, index: u64) -> String {
    match explicit.map(str::trim).filter(|s| !s.is_empty()) {
        Some(name) => branch::sanitize_branch(name),
        None => branch::default_branch(branch::DEFAULT_BRANCH_PREFIX, workspace, index as usize),
    }
}

/// Inspect a working directory: is it a git repo, and if so its `HEAD`/branch.
/// Never errors — a non-repo simply reports `is_repo: false`.
#[tauri::command]
pub fn worktree_inspect(path: String) -> RepoInfo {
    let path = Path::new(&path);
    if !repo::is_git_repo(path) {
        return RepoInfo {
            is_repo: false,
            head: None,
            branch: None,
        };
    }
    RepoInfo {
        is_repo: true,
        head: repo::resolve_commit(path, "HEAD").ok(),
        branch: repo::current_branch(path).ok().flatten(),
    }
}

/// Create an agent's worktree under `base_dir`, on a new branch, at the pinned
/// base commit. Serialized per repo. Returns the path + branch to store.
#[tauri::command]
pub fn worktree_create(
    locks: State<RepoLocks>,
    spec: CreateSpec,
) -> Result<WorktreeRecord, String> {
    let repo_path = PathBuf::from(&spec.repo);
    if !repo::is_git_repo(&repo_path) {
        return Err(format!("not a git repository: {}", spec.repo));
    }

    let base_dir = PathBuf::from(&spec.base_dir);
    std::fs::create_dir_all(&base_dir).map_err(|e| format!("create worktree base dir: {e}"))?;

    let base = match spec.base.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(rev) => rev.to_string(),
        None => repo::resolve_commit(&repo_path, "HEAD").map_err(|e| e.to_string())?,
    };

    let chosen_branch = choose_branch(spec.branch.as_deref(), &spec.workspace, spec.index);
    // Explicit dir wins (sanitized to one fs-safe segment); else derive it from
    // the branch (slashes -> dashes) so it matches the pane header.
    let chosen_dir = match spec.dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => branch::sanitize_branch_component(d),
        None => chosen_branch.replace('/', "-"),
    };

    let lock = locks.for_repo(&repo_path);
    let _guard = lock.lock().expect("repo lock poisoned");

    // Pick a free branch + dir under the lock. Clean worktrees aren't removed on
    // close, so an earlier agent's branch/folder may still exist; append -2, -3,
    // … (to both, kept in step) until the dir is free and the branch is unused.
    let mut branch = chosen_branch.clone();
    let mut dir = chosen_dir.clone();
    let mut path = base_dir.join(&dir);
    let mut suffix = 1u32;
    while path.exists() || repo::branch_exists(&repo_path, &branch).map_err(|e| e.to_string())? {
        suffix += 1;
        if suffix > 999 {
            return Err("could not find a free worktree branch/dir".to_string());
        }
        branch = format!("{chosen_branch}-{suffix}");
        dir = format!("{chosen_dir}-{suffix}");
        path = base_dir.join(&dir);
    }

    worktree::add(&repo_path, &path, &branch, &base).map_err(|e| e.to_string())?;

    Ok(WorktreeRecord {
        agent_id: spec.agent_id,
        path: path.to_string_lossy().into_owned(),
        branch,
    })
}

/// Report whether the worktree at `path` is dirty, plus its branch.
#[tauri::command]
pub fn worktree_status(path: String) -> Result<WorktreeStatus, String> {
    let path = Path::new(&path);
    let dirty = worktree::is_dirty(path).map_err(|e| e.to_string())?;
    let branch = repo::current_branch(path).map_err(|e| e.to_string())?;
    Ok(WorktreeStatus { dirty, branch })
}

/// Remove an agent's worktree. Without `force`, refuses a dirty worktree so work
/// is never destroyed; the branch itself is left intact either way.
#[tauri::command]
pub fn worktree_remove(locks: State<RepoLocks>, spec: RemoveSpec) -> Result<(), String> {
    let repo_path = PathBuf::from(&spec.repo);
    let path = PathBuf::from(&spec.path);

    if !spec.force && worktree::is_dirty(&path).map_err(|e| e.to_string())? {
        return Err("worktree has uncommitted changes; not removing".to_string());
    }

    // Serialize with worktree_create on this repo: remove + prune both take the
    // shared .git locks, so a concurrent add would otherwise fail to lock or
    // have its admin-state pruned mid-write.
    let lock = locks.for_repo(&repo_path);
    let _guard = lock.lock().expect("repo lock poisoned");
    worktree::remove(&repo_path, &path, spec.force).map_err(|e| e.to_string())?;
    // Best-effort: drop the administrative record if the dir is already gone.
    let _ = worktree::prune(&repo_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_branch_is_sanitized_and_wins() {
        assert_eq!(choose_branch(Some("feat/my login"), "ws", 2), "feat/my-login");
    }

    #[test]
    fn blank_explicit_falls_back_to_auto() {
        assert_eq!(choose_branch(Some("   "), "My WS", 4), "kd/My-WS/4");
        assert_eq!(choose_branch(None, "ws", 0), "kd/ws/0");
    }
}
