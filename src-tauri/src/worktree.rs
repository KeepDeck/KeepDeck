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

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use keepdeck_git::{branch, provenance, repo, worktree};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Per-repository locks that serialize `git worktree add`. Tauri managed state.
///
/// Two agents spawning at once would otherwise race on the repo's `.git`
/// config/ref locks; we hold the repo's lock across the add so they queue.
/// Clonable handle (the map is shared behind an `Arc`) so a command can move
/// one into the blocking task that does the git work.
#[derive(Default, Clone)]
pub struct RepoLocks {
    inner: Arc<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>>,
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
    /// Exact, user-chosen worktree path ([F2]). When set, the worktree is
    /// created AT this path verbatim — its parent is created, git accepts a
    /// non-existent or existing-empty dir, and there is NO collision suffix
    /// (`base_dir`/`dir` are ignored). Absent → the batch flow uses
    /// `base_dir` + `dir` with auto-suffixing.
    pub path: Option<String>,
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
    /// When set (and non-blank), also delete this branch after the worktree is
    /// removed; otherwise the branch is left intact. `force` selects `-D` (drops
    /// unmerged commits) over the safe `-d`. Used by "delete worktree + branch
    /// on close" — the branch can't be deleted while its worktree exists, so it
    /// happens here, after the removal, under the same per-repo lock.
    #[serde(default)]
    pub branch: Option<String>,
    /// Also delete every branch CREATED inside this worktree (reflog
    /// provenance — see `keepdeck_git::provenance`): the close dialog's delete
    /// intent covers the agent's side branches, not just the tracked one. A
    /// created branch that meanwhile moved to another worktree is in use, not
    /// litter, and is kept.
    #[serde(default)]
    pub reap_created_branches: bool,
}

/// Pick the branch to create: an explicit non-blank name (sanitized per
/// component), else the auto `kd/<workspace>/<index>` default. Pure, unit-tested.
fn choose_branch(explicit: Option<&str>, workspace: &str, index: u64) -> String {
    match explicit.map(str::trim).filter(|s| !s.is_empty()) {
        Some(name) => branch::sanitize_branch(name),
        None => branch::default_branch(branch::DEFAULT_BRANCH_PREFIX, workspace, index as usize),
    }
}

/// First of `wanted`, `wanted-2`, `wanted-3`, … that names no existing branch
/// in the repo. Worktrees — and their branches — deliberately survive pane
/// closes, so an exact-path create steps over leftovers instead of failing on
/// `git worktree add -b` (the batch flow suffixes the same way, jointly with
/// its dir).
fn free_branch(repo_path: &Path, wanted: &str) -> Result<String, String> {
    for n in 1..=branch::WORKTREE_SUFFIX_MAX {
        let candidate = branch::suffixed_name(wanted, n);
        if !repo::branch_exists(repo_path, &candidate).map_err(|e| e.to_string())? {
            return Ok(candidate);
        }
    }
    Err(format!("could not find a free branch derived from {wanted}"))
}

/// Suggested defaults for a new agent in worktree mode — the single source of
/// the branch/folder naming, mirrored into the "+ Agent" dialog.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSuggestion {
    pub branch: String,
    pub folder: String,
}

/// Default branch + folder for the `index`-th agent of `workspace`.
#[tauri::command]
pub fn worktree_suggest(workspace: String, index: u64) -> WorktreeSuggestion {
    let branch = branch::default_branch(branch::DEFAULT_BRANCH_PREFIX, &workspace, index as usize);
    let folder = branch.replace('/', "-");
    WorktreeSuggestion { branch, folder }
}

/// What the UI learns about a candidate worktree PATH typed in the "+ Agent"
/// dialog, to drive its live location hint ([F2], the per-agent worktree/main
/// choice). Mirrors [`RepoInfo`]'s role for the workspace working directory.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathProbe {
    /// Whether the path exists on disk (distinguishes "new worktree" from a
    /// folder that's already there).
    pub exists: bool,
    /// Whether it's a git work tree we could attach an agent to instead of
    /// creating one.
    pub is_worktree: bool,
    /// Whether an existing, non-worktree directory is empty. A worktree can be
    /// created INTO an empty dir (git allows it), but not into a non-empty one —
    /// so an empty existing folder is usable while a non-empty one is blocked.
    pub empty: bool,
    /// The branch checked out there, when it is a worktree on a branch.
    pub branch: Option<String>,
}

/// Probe a candidate worktree path for the agent dialog's live hint. Never
/// errors: an unusable path simply reports `exists: false`. `(async)`: it
/// stats the filesystem and shells out to git — off the main thread.
#[tauri::command(async)]
pub fn worktree_probe(path: String) -> PathProbe {
    let path = Path::new(&path);
    let exists = path.exists();
    // The ROOT only: a subdirectory of a repo is "inside a work tree" too, but
    // attaching an agent there would put it on the main branch with no
    // isolation — the opposite of what picking a worktree means.
    let is_worktree = exists && repo::is_worktree_root(path);
    // Only relevant for an existing non-worktree dir: is it empty (usable) or not.
    let empty = exists
        && !is_worktree
        && std::fs::read_dir(path)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
    let branch = if is_worktree {
        repo::current_branch(path).ok().flatten()
    } else {
        None
    };
    PathProbe {
        exists,
        is_worktree,
        empty,
        branch,
    }
}

/// The repo's local branch names — the options behind the "+ Agent" dialog's
/// base-branch picker. The most likely base leads: the repo's default branch
/// (the remote HEAD) when it exists locally, else the checked-out branch;
/// the rest stay alphabetical. Errors (not a repo, git failure) surface to
/// the caller, which flattens them to "no list" and degrades the picker to a
/// plain input. `(async)`: it shells out to git — off the main thread.
#[tauri::command(async)]
pub fn worktree_branches(repo: String) -> Result<Vec<String>, String> {
    let path = Path::new(&repo);
    if !repo::is_git_repo(path) {
        return Err(format!("not a git repository: {repo}"));
    }
    base_branch_options(path)
}

/// [`worktree_branches`] body: the alphabetical local list with the best base
/// candidate pinned first — the default branch if it names a local branch
/// (you can't base a worktree on a ref that only exists on the remote), else
/// the current one. No candidate (detached HEAD, no remote) = plain list.
fn base_branch_options(path: &Path) -> Result<Vec<String>, String> {
    let list = repo::list_branches(path).map_err(|e| e.to_string())?;
    let pin = repo::default_branch(path)
        .ok()
        .flatten()
        .filter(|name| list.iter().any(|b| b == name))
        .or_else(|| repo::current_branch(path).ok().flatten());
    Ok(branch::pin_first(list, pin.as_deref()))
}

/// Inspect a working directory: is it a git repo, and if so its `HEAD`/branch.
/// Never errors — a non-repo simply reports `is_repo: false`. `(async)`: it
/// shells out to git — off the main thread.
#[tauri::command(async)]
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
///
/// Runs on the blocking pool: `git worktree add` checks out a full working
/// tree, and a non-async command would occupy the main thread for the
/// duration — stalling every other IPC call (keystrokes, PTY output, menus).
#[tauri::command]
pub async fn worktree_create(
    locks: State<'_, RepoLocks>,
    spec: CreateSpec,
) -> Result<WorktreeRecord, String> {
    let locks = locks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || create_worktree(&locks, spec))
        .await
        .map_err(|e| format!("worktree create task failed: {e}"))?
}

/// [`worktree_create`] body, decoupled from Tauri state for testability.
fn create_worktree(locks: &RepoLocks, spec: CreateSpec) -> Result<WorktreeRecord, String> {
    let repo_path = PathBuf::from(&spec.repo);
    if !repo::is_git_repo(&repo_path) {
        return Err(format!("not a git repository: {}", spec.repo));
    }

    let base = match spec.base.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(rev) => rev.to_string(),
        None => repo::resolve_commit(&repo_path, "HEAD").map_err(|e| e.to_string())?,
    };

    let chosen_branch = choose_branch(spec.branch.as_deref(), &spec.workspace, spec.index);

    let lock = locks.for_repo(&repo_path);
    let _guard = lock.lock().expect("repo lock poisoned");

    // [F2] Exact user-chosen path: create the worktree AT it verbatim, with NO
    // path collision suffix — the user picked this exact folder (git accepts a
    // non-existent or existing-empty dir; a non-empty one surfaces as an error
    // the dialog shows). The BRANCH does step over leftovers: closed panes keep
    // their branches by design, so a colliding suggestion must not fail the
    // create — the record carries the branch actually used.
    if let Some(p) = spec.path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let target = PathBuf::from(p);
        let branch = free_branch(&repo_path, &chosen_branch)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create worktree parent dir: {e}"))?;
        }
        worktree::add(&repo_path, &target, &branch, &base).map_err(|e| e.to_string())?;
        return Ok(WorktreeRecord {
            agent_id: spec.agent_id,
            path: target.to_string_lossy().into_owned(),
            branch,
        });
    }

    // Batch flow: place the worktree under `base_dir`. Explicit dir wins
    // (sanitized to one fs-safe segment); else derive it from the branch
    // (slashes -> dashes) so it matches the pane header.
    let base_dir = PathBuf::from(&spec.base_dir);
    std::fs::create_dir_all(&base_dir).map_err(|e| format!("create worktree base dir: {e}"))?;
    let chosen_dir = match spec.dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => branch::sanitize_branch_component(d),
        None => chosen_branch.replace('/', "-"),
    };

    // Pick a free branch + dir under the lock. Clean worktrees aren't removed on
    // close, so an earlier agent's branch/folder may still exist; the shared
    // suffix scheme steps branch and dir together (base, base-2, …) until the
    // dir is free and the branch is unused.
    let mut chosen: Option<(String, PathBuf)> = None;
    for n in 1..=branch::WORKTREE_SUFFIX_MAX {
        let branch = branch::suffixed_name(&chosen_branch, n);
        let dir = branch::suffixed_name(&chosen_dir, n);
        let path = base_dir.join(&dir);
        if !path.exists()
            && !repo::branch_exists(&repo_path, &branch).map_err(|e| e.to_string())?
        {
            chosen = Some((branch, path));
            break;
        }
    }
    let (branch, path) =
        chosen.ok_or_else(|| "could not find a free worktree branch/dir".to_string())?;

    worktree::add(&repo_path, &path, &branch, &base).map_err(|e| e.to_string())?;

    Ok(WorktreeRecord {
        agent_id: spec.agent_id,
        path: path.to_string_lossy().into_owned(),
        branch,
    })
}

/// Remove an agent's worktree, and — when `spec.branch` is set — delete that
/// branch too. Without `force`, refuses a dirty worktree so work is never
/// destroyed; with `branch` but no `force`, the branch delete uses the safe
/// `-d`, which git refuses for unmerged commits.
///
/// Runs on the blocking pool like [`worktree_create`]: a forced remove deletes
/// the whole worktree directory, which can take a while.
#[tauri::command]
pub async fn worktree_remove(locks: State<'_, RepoLocks>, spec: RemoveSpec) -> Result<(), String> {
    let locks = locks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || remove_worktree(&locks, spec))
        .await
        .map_err(|e| format!("worktree remove task failed: {e}"))?
}

/// [`worktree_remove`] body, decoupled from Tauri state for testability.
///
/// An externally-deleted worktree directory must never abort the removal:
/// there is no work left to lose, and bailing out would leak the `.git`
/// registration and the `kd/…` branch forever. So the dirty check only runs
/// while the directory exists, and a failed `git worktree remove` on a gone
/// directory falls through to `prune`, which is exactly the tool for that.
fn remove_worktree(locks: &RepoLocks, spec: RemoveSpec) -> Result<(), String> {
    let repo_path = PathBuf::from(&spec.repo);
    let path = PathBuf::from(&spec.path);

    if !spec.force && path.exists() && worktree::is_dirty(&path).map_err(|e| e.to_string())? {
        return Err("worktree has uncommitted changes; not removing".to_string());
    }

    // Serialize with worktree_create on this repo: remove + prune + branch
    // delete all take the shared .git locks, so a concurrent add would otherwise
    // fail to lock or have its admin-state pruned mid-write.
    let lock = locks.for_repo(&repo_path);
    let _guard = lock.lock().expect("repo lock poisoned");

    // Branches born in this worktree are enumerated BEFORE the removal: the
    // evidence is the worktree's private HEAD reflog, which `git worktree
    // remove` destroys with the administrative dir. A failed scan degrades to
    // "reap nothing extra" — the close itself must not hinge on provenance.
    let created = if spec.reap_created_branches && path.exists() {
        match provenance::created_branches(&repo_path, &path) {
            Ok(branches) => branches,
            Err(e) => {
                log::warn!(
                    "worktree: created-branch scan failed in {}: {e}",
                    path.display()
                );
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    match worktree::remove(&repo_path, &path, spec.force) {
        Ok(()) => {}
        // Git refuses to `remove` a worktree whose dir is already gone; only a
        // failure with the dir still present is a real error.
        Err(_) if !path.exists() => {}
        Err(e) => return Err(e.to_string()),
    }
    // Drop the administrative record (best-effort) — after the remove above,
    // or INSTEAD of it when the dir vanished externally.
    if let Err(e) = worktree::prune(&repo_path) {
        log::warn!("worktree: prune after remove failed in {}: {e}", repo_path.display());
    }
    // Branch removal is separate: a branch can't be deleted while its worktree
    // is checked out, so it only runs now that the worktree is gone — the
    // tracked branch first, then the worktree-born extras (minus the overlap:
    // the tracked branch usually IS one of them).
    let primary = spec
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let extras: Vec<&str> = created
        .iter()
        .map(String::as_str)
        .filter(|b| Some(*b) != primary)
        .collect();
    // An extra that moved on to ANOTHER worktree since its birth here is in
    // use, not litter — deleting (or failing loudly) would both be wrong, so
    // it's kept with only a log line. The tracked branch never trips this:
    // it was checked out HERE, and this worktree is gone.
    let checked_out_elsewhere: HashSet<String> = if extras.is_empty() {
        HashSet::new()
    } else {
        worktree::list(&repo_path)
            .map(|list| list.into_iter().filter_map(|w| w.branch).collect())
            .unwrap_or_default()
    };

    let mut failures = Vec::new();
    for branch in primary.into_iter().chain(extras) {
        if checked_out_elsewhere.contains(branch) {
            log::warn!(
                "worktree: branch '{branch}' is checked out in another worktree of {}; keeping it",
                repo_path.display()
            );
            continue;
        }
        failures.extend(delete_branch_if_present(&repo_path, branch, spec.force));
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}

/// Delete `branch` unless it's already gone — someone beating us to it means
/// already-cleaned, not failed. Returns the user-facing message on failure so
/// the caller can keep going and report every branch that resisted, instead of
/// aborting the sweep at the first one.
fn delete_branch_if_present(repo_path: &Path, branch: &str, force: bool) -> Option<String> {
    match repo::branch_exists(repo_path, branch) {
        Ok(true) => repo::delete_branch(repo_path, branch, force).err().map(|e| {
            format!(
                "Couldn’t delete branch '{branch}' after removing the worktree. \
                 You may need to delete it manually. Reason: {e}"
            )
        }),
        Ok(false) => {
            log::warn!(
                "worktree: branch '{branch}' was already gone in {}; skipping branch delete",
                repo_path.display()
            );
            None
        }
        Err(e) => Some(format!(
            "Couldn’t check whether branch '{branch}' exists: {e}"
        )),
    }
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

    #[test]
    fn probe_flags_a_missing_path_as_new() {
        // A path that doesn't exist → "new worktree" territory, no branch.
        let missing = std::env::temp_dir().join("keepdeck-probe-absent-a9f3c1");
        let _ = std::fs::remove_dir_all(&missing);
        let p = worktree_probe(missing.to_string_lossy().into_owned());
        assert!(!p.exists);
        assert!(!p.is_worktree);
        assert!(!p.empty);
        assert_eq!(p.branch, None);
    }

    #[test]
    fn probe_flags_an_existing_empty_dir_as_usable() {
        // An existing EMPTY dir is fine — git can create a worktree into it.
        let dir = std::env::temp_dir().join("keepdeck-probe-empty-7c2b40");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = worktree_probe(dir.to_string_lossy().into_owned());
        assert!(p.exists);
        assert!(!p.is_worktree);
        assert!(p.empty);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_flags_an_existing_nonempty_dir_as_blocked() {
        // A non-empty non-worktree dir can't host a worktree → not empty.
        let dir = std::env::temp_dir().join("keepdeck-probe-nonempty-3d19aa");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("file.txt"), "x").unwrap();
        let p = worktree_probe(dir.to_string_lossy().into_owned());
        assert!(p.exists);
        assert!(!p.is_worktree);
        assert!(!p.empty);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Run a git command in `dir`, asserting it succeeds (test setup helper).
    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed in {}", dir.display());
    }

    /// A throwaway repo with one commit, for the branch-collision tests.
    fn init_repo(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "keepdeck-free-branch-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["config", "user.email", "test@keepdeck.ai"]);
        git(&dir, &["config", "user.name", "KeepDeck Test"]);
        std::fs::write(dir.join("README.md"), "hi").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn base_branch_options_pin_the_default_else_the_current_branch() {
        let repo = init_repo("branch-order");
        let current = git_out(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .trim()
            .to_string();
        git(&repo, &["branch", "alpha"]);
        git(&repo, &["branch", "zeta"]);

        // No remote HEAD → the checked-out branch leads, the rest alphabetical.
        let opts = base_branch_options(&repo).unwrap();
        assert_eq!(opts, [current.clone(), "alpha".to_string(), "zeta".to_string()]);

        // A remote HEAD naming a LOCAL branch outranks the checked-out one…
        git(&repo, &["update-ref", "refs/remotes/origin/zeta", "HEAD"]);
        git(
            &repo,
            &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/zeta"],
        );
        assert_eq!(base_branch_options(&repo).unwrap()[0], "zeta");

        // …but a default with no local branch falls back to the current one.
        git(&repo, &["update-ref", "refs/remotes/origin/ghost", "HEAD"]);
        git(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/ghost",
            ],
        );
        assert_eq!(base_branch_options(&repo).unwrap()[0], current);

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn free_branch_keeps_an_unused_name() {
        let repo = init_repo("unused");
        assert_eq!(free_branch(&repo, "kd/ws/1").unwrap(), "kd/ws/1");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn free_branch_steps_over_leftover_branches() {
        // Leftovers from closed panes: the wanted name and its -2 both exist.
        let repo = init_repo("taken");
        git(&repo, &["branch", "kd/ws/1"]);
        git(&repo, &["branch", "kd/ws/1-2"]);
        assert_eq!(free_branch(&repo, "kd/ws/1").unwrap(), "kd/ws/1-3");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn create_suffixes_branch_and_dir_together_over_leftovers() {
        // Clean worktrees survive pane closes by design, so a second create
        // with the same workspace/index must step over the first one's branch
        // AND folder, keeping both suffixes in step.
        let repo = init_repo("create-suffix");
        let base_dir = repo.with_file_name(format!(
            "{}-wts",
            repo.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&base_dir);
        let spec = |agent: &str| CreateSpec {
            repo: repo.to_string_lossy().into_owned(),
            base_dir: base_dir.to_string_lossy().into_owned(),
            agent_id: agent.to_string(),
            branch: None,
            base: None,
            workspace: "ws".to_string(),
            index: 1,
            dir: None,
            path: None,
        };
        let locks = RepoLocks::default();

        let first = create_worktree(&locks, spec("pane-1")).expect("first create");
        let second = create_worktree(&locks, spec("pane-2")).expect("second create");

        assert_eq!(first.branch, "kd/ws/1");
        assert!(first.path.ends_with("kd-ws-1"), "path: {}", first.path);
        assert_eq!(second.branch, "kd/ws/1-2");
        assert!(second.path.ends_with("kd-ws-1-2"), "path: {}", second.path);
        let _ = std::fs::remove_dir_all(&base_dir);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A repo with a `kd/<label>` branch checked out in a sibling worktree.
    fn repo_with_worktree(label: &str) -> (PathBuf, PathBuf, String) {
        let repo = init_repo(label);
        let branch = format!("kd/{label}/1");
        let wt = repo.with_file_name(format!(
            "{}-wt",
            repo.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&wt);
        git(&repo, &["worktree", "add", "-q", "-b", &branch, wt.to_str().unwrap()]);
        (repo, wt, branch)
    }

    /// Like [`git`], but with the committer date — and so every reflog entry
    /// the command writes — pinned to `ts`. Provenance pairs creation
    /// timestamps with checkout entries, so a test must keep "created
    /// elsewhere" out of the same second as "checked out here": unpinned,
    /// this whole setup runs inside one second and manufactures the exact
    /// collision the attribution declines to resolve.
    fn git_at(dir: &Path, ts: u64, args: &[&str]) {
        let status = std::process::Command::new("git")
            .env("GIT_COMMITTER_DATE", format!("{ts} +0000"))
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed in {}", dir.display());
    }

    /// Stdout of a git query in `repo` (assertion helper).
    fn git_out(repo: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .expect("run git");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn remove_reaps_registration_and_branch_when_the_dir_was_deleted_externally() {
        // The dir vanished behind KeepDeck's back (manual rm, cleanup tool).
        // `git worktree remove` refuses a gone dir — the removal must fall
        // through to prune instead of aborting, or the .git registration and
        // the kd/ branch leak forever.
        let (repo, wt, branch) = repo_with_worktree("reap-forced");
        std::fs::remove_dir_all(&wt).unwrap();

        remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: wt.to_string_lossy().into_owned(),
                force: true,
                branch: Some(branch.clone()),
                reap_created_branches: false,
            },
        )
        .expect("a gone dir must not abort the removal");

        let list = git_out(&repo, &["worktree", "list", "--porcelain"]);
        assert!(!list.contains("-wt"), "registration leaked:\n{list}");
        let branches = git_out(&repo, &["branch", "--list", &branch]);
        assert!(branches.trim().is_empty(), "branch leaked: {branches}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_without_force_skips_the_dirty_check_on_a_gone_dir() {
        // The default (safe) path: is_dirty shells `git -C <path> status`,
        // which errors on a missing dir — that error must read as "nothing to
        // lose", not abort the whole removal.
        let (repo, wt, branch) = repo_with_worktree("reap-default");
        std::fs::remove_dir_all(&wt).unwrap();

        remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: wt.to_string_lossy().into_owned(),
                force: false,
                branch: Some(branch.clone()),
                reap_created_branches: false,
            },
        )
        .expect("a gone dir has nothing to lose — the safe path must proceed");

        let branches = git_out(&repo, &["branch", "--list", &branch]);
        assert!(branches.trim().is_empty(), "branch leaked: {branches}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_succeeds_when_the_branch_is_already_gone() {
        // If the user switched to another branch and deleted ours, the worktree
        // folder is still removed and the cleanup is considered successful.
        let (repo, wt, branch) = repo_with_worktree("branch-gone");
        git(&wt, &["checkout", "-b", "tmp"]); // move the worktree off our branch
        git(&repo, &["branch", "-D", &branch]); // now the branch can be deleted

        remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: wt.to_string_lossy().into_owned(),
                force: true,
                branch: Some(branch.clone()),
                reap_created_branches: false,
            },
        )
        .expect("removal must succeed when the branch is already gone");

        assert!(!wt.exists(), "worktree dir must be removed");
        let list = git_out(&repo, &["worktree", "list", "--porcelain"]);
        assert!(!list.contains("-wt"), "registration leaked:\n{list}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_reports_a_user_friendly_error_when_branch_delete_fails() {
        // An unmerged branch with force=false makes `git branch -d` fail. The
        // error must explain what happened instead of showing raw git output.
        let (repo, wt, branch) = repo_with_worktree("unmerged-branch");
        std::fs::write(wt.join("feature.txt"), "work").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-q", "-m", "unmerged"]);

        let result = remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: wt.to_string_lossy().into_owned(),
                force: false,
                branch: Some(branch),
                reap_created_branches: false,
            },
        );

        let err = result.expect_err("unmerged branch must fail to delete");
        assert!(
            err.contains("Couldn’t delete branch"),
            "error should be user-friendly: {err}"
        );
        assert!(!wt.exists(), "worktree dir must still be removed");
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&wt);
    }

    #[test]
    fn remove_with_reap_deletes_branches_born_in_the_worktree() {
        // The agent made a side branch during its session; closing with the
        // delete checkbox must sweep it along with the tracked branch, while a
        // branch that merely VISITED the worktree stays.
        let (repo, wt, branch) = repo_with_worktree("reap-created");
        git_at(&repo, 1_700_000_000, &["branch", "visitor"]);
        git(&wt, &["switch", "-q", "-c", "kd/side-branch"]);
        git(&wt, &["switch", "-q", "visitor"]);

        remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: wt.to_string_lossy().into_owned(),
                force: true,
                branch: Some(branch.clone()),
                reap_created_branches: true,
            },
        )
        .expect("remove with reap");

        for gone in [branch.as_str(), "kd/side-branch"] {
            let out = git_out(&repo, &["branch", "--list", gone]);
            assert!(out.trim().is_empty(), "branch leaked: {gone}");
        }
        let visitor = git_out(&repo, &["branch", "--list", "visitor"]);
        assert!(!visitor.trim().is_empty(), "the visiting branch was reaped");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_with_reap_keeps_a_created_branch_now_checked_out_elsewhere() {
        // A branch born here but since adopted by another worktree is in use —
        // it must survive, and without failing the close.
        let (repo, wt, branch) = repo_with_worktree("reap-adopted");
        git(&wt, &["switch", "-q", "-c", "kd/adopted"]);
        git(&wt, &["switch", "-q", &branch]);
        let other = repo.with_file_name(format!(
            "{}-other",
            repo.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&other);
        git(&repo, &["worktree", "add", "-q", other.to_str().unwrap(), "kd/adopted"]);

        remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: wt.to_string_lossy().into_owned(),
                force: true,
                branch: Some(branch),
                reap_created_branches: true,
            },
        )
        .expect("an adopted branch must not fail the close");

        let adopted = git_out(&repo, &["branch", "--list", "kd/adopted"]);
        assert!(!adopted.trim().is_empty(), "the adopted branch was reaped");
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn remove_without_force_still_refuses_a_dirty_worktree() {
        // The safety property the dirty check exists for must survive the fix.
        let (repo, wt, branch) = repo_with_worktree("keep-dirty");
        std::fs::write(wt.join("wip.txt"), "uncommitted").unwrap();

        let result = remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: wt.to_string_lossy().into_owned(),
                force: false,
                branch: Some(branch),
                reap_created_branches: false,
            },
        );

        assert!(result.is_err(), "dirty worktree must be kept");
        assert!(wt.join("wip.txt").exists(), "work was destroyed");
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&wt);
    }
}
