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

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use keepdeck_git::{branch, provenance, repo, worktree, worktree_base};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Per-repository locks that serialize `git worktree add`. Tauri managed state.
///
/// Two agents spawning at once would otherwise race on the repo's `.git`
/// config/ref locks; we hold the repo's lock across the add so they queue.
/// Clonable handle (the map is shared behind an `Arc`) so a command can move
/// one into the blocking task that does the git work.
///
/// Poison is HARD: a panicked `git worktree add` may have left the repo's
/// shared `.git` state half-written, and the next holder cannot prove it
/// fresh — so the poison surfaces instead of being walked into. (The
/// complementary Recover policy and why the two must not merge: see
/// [`crate::keyed_locks`].)
#[derive(Clone)]
pub struct RepoLocks {
    inner: crate::keyed_locks::KeyedLocks<PathBuf>,
}

impl Default for RepoLocks {
    fn default() -> Self {
        Self {
            inner: crate::keyed_locks::KeyedLocks::new(
                crate::keyed_locks::PoisonPolicy::Hard,
            ),
        }
    }
}

impl RepoLocks {
    /// The lock for `repo`, created on first use. Keyed by the canonical path so
    /// different spellings of the same repo share one lock.
    fn for_repo(&self, repo: &Path) -> Arc<Mutex<()>> {
        let key = std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf());
        self.inner.for_key(key)
    }

    /// Take a repo's lock under this map's poison policy.
    fn acquire<'a>(&self, lock: &'a Mutex<()>) -> MutexGuard<'a, ()> {
        self.inner.acquire(lock)
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
    /// Stable agent id — the record key tying the worktree back to its agent.
    pub agent_id: String,
    /// Explicit branch name to create; auto-generated when absent/blank.
    pub branch: Option<String>,
    /// Base commit/rev; ALWAYS resolved to a commit sha at create time
    /// (defaults to `HEAD`), while a directly-selected local branch is also
    /// retained as worktree-private base identity. The SHA pins the batch and
    /// keeps branch-creation provenance trustworthy.
    pub base: Option<String>,
    /// Local branch identity corresponding to a separately pinned `base` SHA.
    /// A caller that pins the commit itself supplies both, so the worktree
    /// starts at that exact commit while history can still follow the branch
    /// after a rebase.
    pub base_branch: Option<String>,
    /// Workspace name, used only for the auto branch name.
    #[serde(default)]
    pub workspace: String,
    /// Agent index within the workspace, used only for the auto branch name.
    #[serde(default)]
    pub index: u64,
    /// The worktree's exact path ([F2]) — the only placement there is. The
    /// worktree is created AT it verbatim: its parent is created, git accepts a
    /// non-existent or existing-empty dir, and there is NO collision suffix.
    /// Picking a free path is the caller's job, done before it asks (the
    /// "+ Agent" dialog's accepted suggestion, or a fork's target).
    pub path: String,
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
    /// litter, and is kept. Designed for FORCED closes — the one product
    /// caller always sends `force` — since a non-force reap surfaces safe
    /// `-d` refusals for every unmerged side branch.
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

/// Create an agent's worktree at `path`, on a new branch, at the pinned base
/// commit. Serialized per repo. Returns the path + branch to store.
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
    // Asked before the repo lock: a create with nowhere to go should not queue
    // behind everyone else's worktrees to say so.
    let target = PathBuf::from(spec.path.trim());
    if target.as_os_str().is_empty() {
        return Err("worktree create needs a path".to_string());
    }

    // The base is ALWAYS pinned to a commit sha here — a picked branch NAME
    // must not flow into `worktree add -b` verbatim: git would record a
    // name-sourced creation, which reflog provenance deliberately refuses to
    // trust, and the born branch would never be attributed back to this
    // worktree at close time. Pinning also keeps a whole batch on one commit
    // even if the base moves mid-batch. The local branch identity is retained
    // separately in a private base ref for dynamic fork-point resolution.
    let base_rev = spec.base.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let has_explicit_base = base_rev.is_some();
    let base_rev = base_rev.unwrap_or("HEAD");
    let base_branch_rev = spec
        .base_branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .unwrap_or(base_rev);
    let base_branch_ref = repo::local_branch_ref(&repo_path, base_branch_rev)
        .map_err(|e| format!("cannot identify base branch: {e}"))?;
    if spec
        .base_branch
        .as_deref()
        .is_some_and(|branch| !branch.trim().is_empty())
        && base_branch_ref.is_none()
    {
        return Err(format!(
            "cannot identify local base branch '{base_branch_rev}'"
        ));
    }
    let base = repo::resolve_commit(&repo_path, base_rev).map_err(|e| match base_rev {
        "HEAD" if !has_explicit_base => e.to_string(),
        rev => format!("cannot resolve base '{rev}': {e}"),
    })?;

    let chosen_branch = choose_branch(spec.branch.as_deref(), &spec.workspace, spec.index);

    let lock = locks.for_repo(&repo_path);
    let _guard = locks.acquire(&lock);

    // [F2] The worktree is created AT the caller's path verbatim, with NO path
    // collision suffix — the path is the caller's decision (the "+ Agent"
    // dialog's accepted suggestion, or a fork's target), and git accepts a
    // non-existent or existing-empty dir; a non-empty one surfaces as an error
    // the dialog shows. The BRANCH does step over leftovers: closed panes keep
    // their branches by design, so a colliding suggestion must not fail the
    // create — the record carries the branch actually used.
    let branch = free_branch(&repo_path, &chosen_branch)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create worktree parent dir: {e}"))?;
    }
    add_worktree_with_base(
        &repo_path,
        &target,
        &branch,
        &base,
        base_branch_ref.as_deref(),
    )?;

    Ok(WorktreeRecord {
        agent_id: spec.agent_id,
        path: target.to_string_lossy().into_owned(),
        branch,
    })
}

/// Undo a worktree this function just created: remove it, drop the
/// administrative record, delete its branch.
///
/// Its own step, rather than three calls at the rollback site, because that site
/// was a SECOND hand-assembled removal — it skipped the prune that
/// [`remove_worktree`] does, so a rollback git abandoned midway left a
/// registration behind that nothing else would ever clear (the frontend treats a
/// failed create as "nothing landed" and never asks to remove this path again).
fn discard_worktree(repo_path: &Path, path: &Path, branch: &str) -> Result<(), String> {
    worktree::remove(repo_path, path, true)
        .map_err(|e| format!("remove worktree during rollback: {e}"))?;
    // Best-effort, like the prune in `remove_worktree`: the record is stale
    // whether or not git managed to drop it here.
    if let Err(e) = worktree::prune(repo_path) {
        log::warn!(
            "worktree: prune after rollback failed in {}: {e}",
            repo_path.display()
        );
    }
    repo::delete_branch(repo_path, branch, true)
        .map_err(|e| format!("delete branch during rollback: {e}"))
}

/// Provision one worktree and attach its Git-native base metadata as one
/// application-level operation. If metadata cannot be recorded, remove the
/// just-created worktree and branch so callers never receive a partially
/// provisioned agent.
fn add_worktree_with_base(
    repo_path: &Path,
    path: &Path,
    branch: &str,
    base_commit: &str,
    base_branch_ref: Option<&str>,
) -> Result<(), String> {
    worktree::add(repo_path, path, branch, base_commit).map_err(|e| e.to_string())?;

    let managed_branch_ref = format!("refs/heads/{branch}");
    if let Err(metadata_error) = worktree_base::record(
        path,
        base_commit,
        base_branch_ref,
        &managed_branch_ref,
    ) {
        let cleanup_error = discard_worktree(repo_path, path, branch).err();
        let cleanup = cleanup_error
            .map(|e| format!("; rollback also failed: {e}"))
            .unwrap_or_default();
        return Err(format!(
            "could not record worktree base metadata: {metadata_error}{cleanup}"
        ));
    }

    Ok(())
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
///
/// A removal git ABANDONED MIDWAY is treated the same way, and for the same
/// reason: the registration and the branch are separate from the directory, so
/// a directory that resisted must not strand them ([`husk_verdict`]). Only
/// a git that refused before touching anything aborts the whole removal.
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
    let _guard = locks.acquire(&lock);

    // Branches born in this worktree are enumerated BEFORE the removal: the
    // evidence is the worktree's private HEAD reflog, which `git worktree
    // remove`/`prune` destroy with the administrative record. Provenance reads
    // that record through the main repo, so an externally-deleted directory
    // (the fallthrough case below) is still attributable here. A failed scan
    // degrades to "reap nothing extra" — the close must not hinge on it.
    let created = if spec.reap_created_branches {
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

    // Read BEFORE the removal: half the evidence [`husk_verdict`] needs to tell
    // a git that refused from a git that gave up midway.
    let registered = is_registered_worktree(&repo_path, &path);

    let mut leftover = None;
    match worktree::remove(&repo_path, &path, spec.force) {
        Ok(()) => {}
        // Git refuses to `remove` a worktree whose dir is already gone; only a
        // failure with the dir still present is a real error.
        Err(_) if !path.exists() => {}
        Err(e) if husk_verdict(registered, is_registered_worktree(&repo_path, &path)) => {
            // Git deregistered the directory, so no later `git worktree remove`
            // can address it and the prune + branch reap below must run either
            // way. Finishing the DELETE is a separate question: git can abandon
            // having unlinked nothing at all — a subdirectory it cannot enter
            // aborts its recursion where it stands — so the leftover may still
            // hold every file the user had, and only a forced removal is
            // consent to lose them.
            leftover = if spec.force {
                clear_husk(&path).err().map(|why| format!("{e}; {why}"))
            } else {
                Some(format!(
                    "{e}; '{}' was left in place: finishing the deletion needs a forced removal",
                    path.display()
                ))
            };
        }
        // Git refused before touching anything, or could not tell us it did:
        // the worktree is intact and must stay that way — its branch included.
        //
        // There is deliberately NO arm for "a husk an earlier attempt could not
        // finish". One existed and was removed: it recognised a leftover by a
        // `.git` pointer whose target was missing, which is ALSO what a healthy
        // submodule and any worktree under `worktree.useRelativePaths` look like
        // (git writes those pointers relative to the `.git` file, and `exists()`
        // resolved them against the process cwd) — so a forced removal git had
        // refused deleted live trees. It could not have worked anyway: the
        // evidence it read is a file `clear_husk` may itself unlink before it
        // fails. A directory left by a failed `clear_husk` is now removed by
        // hand; recovering it in-app would have to ask git, not the filesystem.
        Err(e) => return Err(e.to_string()),
    }
    // Drop the administrative record (best-effort) — after the remove above,
    // or INSTEAD of it when the dir vanished externally.
    if let Err(e) = worktree::prune(&repo_path) {
        log::warn!("worktree: prune after remove failed in {}: {e}", repo_path.display());
    }
    // Branch removal is separate: a branch can't be deleted while its worktree
    // is checked out, so it only runs now that the worktree is gone.
    let primary = spec
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let failures = reap_branches(&repo_path, primary, &created, spec.force);
    let problems: Vec<String> = leftover.into_iter().chain(failures).collect();
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n"))
    }
}

/// Did git abandon the removal PAST its own point of no return?
///
/// `git worktree remove` deletes the administrative record even when deleting
/// the working directory fails — "there's no going back from here", in its own
/// source's words. So a registration that provably vanished across the call
/// means the worktree no longer exists as far as git is concerned: no later
/// `git worktree remove` can address the leftover, and abandoning the prune and
/// the branch reap there is what strands a `kd/…` branch with no worktree.
///
/// Pure, and three-valued on purpose. "Registered", "not registered" and "could
/// not tell" are three different answers, and only the middle one may follow a
/// "registered": anything else means git refused (a locked worktree,
/// submodules, a tree dirtier than our own check saw) or that we simply do not
/// know — and this verdict is what authorizes deleting a directory, so an
/// unknown must never read as a vanished one.
fn husk_verdict(before: Option<bool>, after: Option<bool>) -> bool {
    matches!((before, after), (Some(true), Some(false)))
}

/// Whether `path` is currently one of `repo_path`'s registered worktrees, or
/// `None` when that cannot be established.
///
/// The comparison itself belongs to `keepdeck_git` — it is the same one git's
/// administrative records need, and a third variant written here was exactly the
/// kind of duplication that drifts. This adds only the three-valued reading:
/// `None` is deliberately NOT `Some(false)`, because `git worktree list` drops an
/// entry whose admin record it cannot read while still exiting 0, so "absent from
/// the listing" is evidence of deregistration only when the listing was sound.
fn is_registered_worktree(repo_path: &Path, path: &Path) -> Option<bool> {
    match worktree::is_registered(repo_path, path) {
        Ok(registered) => Some(registered),
        Err(e) => {
            log::warn!(
                "worktree: can't list the worktrees of {} ({e}); \
                 the registration of {} is unknown",
                repo_path.display(),
                path.display()
            );
            None
        }
    }
}

/// Delete what git left behind at `path`.
///
/// Called only where [`husk_verdict`] holds AND the caller asked for a forced
/// removal. Both halves matter: the verdict says git deregistered the directory
/// so nothing else can clear it, and the force flag is the consent — git may
/// have abandoned the recursion before unlinking anything, so what is left can
/// be the user's whole tree, ignored files included. Reported, not thrown, so
/// the registration and branch cleanup still run.
fn clear_husk(path: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!(
            "leftover directory '{}' could not be removed: {e}",
            path.display()
        )),
    }
}

/// Delete the tracked branch and the worktree-born extras (minus the overlap:
/// the tracked branch usually IS one of them), returning the user-facing
/// message for every branch that resisted — one stubborn branch must not hide
/// the rest. The decision of WHAT to sweep is [`sweep_targets`]'s; this
/// function only gathers the in-use info and executes.
fn reap_branches(
    repo_path: &Path,
    primary: Option<&str>,
    created: &[String],
    force: bool,
) -> Vec<String> {
    let extras: Vec<&str> = created
        .iter()
        .map(String::as_str)
        .filter(|b| Some(*b) != primary)
        .collect();
    // In-use info: which branches the surviving worktrees hold. Only needed
    // when extras exist; a failed `worktree list` is "info unavailable".
    let adopted: Option<HashSet<String>> = if extras.is_empty() {
        Some(HashSet::new())
    } else {
        match worktree::list(repo_path) {
            Ok(list) => Some(list.into_iter().filter_map(|w| w.branch).collect()),
            Err(e) => {
                log::warn!(
                    "worktree: can't tell which branches are in use in {} ({e}); \
                     keeping {} created branch(es)",
                    repo_path.display(),
                    extras.len()
                );
                None
            }
        }
    };
    let targets = sweep_targets(primary, &extras, adopted.as_ref());
    if adopted.is_some() {
        for kept in primary
            .iter()
            .copied()
            .chain(extras.iter().copied())
            .filter(|b| !targets.contains(b))
        {
            log::warn!(
                "worktree: branch '{kept}' is checked out in another worktree of {}; keeping it",
                repo_path.display()
            );
        }
    }

    let mut failures = Vec::new();
    for branch in targets {
        if let Err(message) = delete_branch_if_present(repo_path, branch, force) {
            failures.push(message);
        }
    }
    failures
}

/// Pure sweep policy — which branches the reap attempts, given the tracked
/// branch, the worktree-born extras, and the in-use info from `worktree list`
/// (`None` = that info is unavailable). The three cells, spelled out: with
/// info, everything not currently checked out in another worktree — the
/// guard shields the tracked branch too; without info, every extra is kept
/// (deleting blind could hit an in-use branch) and only the tracked branch —
/// explicit close intent — is attempted: the pre-reap contract.
fn sweep_targets<'a>(
    primary: Option<&'a str>,
    extras: &[&'a str],
    adopted: Option<&HashSet<String>>,
) -> Vec<&'a str> {
    let Some(adopted) = adopted else {
        return primary.into_iter().collect();
    };
    primary
        .into_iter()
        .chain(extras.iter().copied())
        .filter(|branch| !adopted.contains(*branch))
        .collect()
}

/// Delete `branch` unless it's already gone — someone beating us to it means
/// already-cleaned, not failed. `Err` carries the user-facing message so the
/// caller can keep sweeping and report every branch that resisted, instead of
/// aborting at the first one.
fn delete_branch_if_present(repo_path: &Path, branch: &str, force: bool) -> Result<(), String> {
    match repo::branch_exists(repo_path, branch) {
        Ok(true) => repo::delete_branch(repo_path, branch, force).map_err(|e| {
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
            Ok(())
        }
        Err(e) => Err(format!(
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
        configure_repo(&dir);
        dir
    }

    fn init_sha256_repo(label: &str) -> Option<PathBuf> {
        let dir = std::env::temp_dir().join(format!(
            "keepdeck-free-branch-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["init", "-q", "--object-format=sha256"])
            .status()
            .expect("run git init");
        if !status.success() {
            let _ = std::fs::remove_dir_all(&dir);
            eprintln!("git does not support SHA-256 repositories; skipping");
            return None;
        }
        configure_repo(&dir);
        Some(dir)
    }

    fn configure_repo(dir: &Path) {
        git(dir, &["config", "user.email", "test@keepdeck.ai"]);
        git(dir, &["config", "user.name", "KeepDeck Test"]);
        std::fs::write(dir.join("README.md"), "hi").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", "init"]);
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
    fn create_steps_the_branch_over_a_leftover_from_a_closed_pane() {
        // Clean worktrees survive pane closes by design, so a second create
        // with the same workspace/index meets the first one's branch still
        // there. The path is the caller's and is used verbatim; the BRANCH
        // steps aside so the create does not fail on a leftover.
        let repo = init_repo("create-suffix");
        let wt = |n: u32| {
            repo.with_file_name(format!(
                "{}-wt{n}",
                repo.file_name().unwrap().to_string_lossy()
            ))
        };
        let _ = std::fs::remove_dir_all(wt(1));
        let _ = std::fs::remove_dir_all(wt(2));
        let spec = |agent: &str, n: u32| CreateSpec {
            repo: repo.to_string_lossy().into_owned(),
            agent_id: agent.to_string(),
            branch: None,
            base: None,
            base_branch: None,
            workspace: "ws".to_string(),
            index: 1,
            path: wt(n).to_string_lossy().into_owned(),
        };
        let locks = RepoLocks::default();

        let first = create_worktree(&locks, spec("pane-1", 1)).expect("first create");
        let second = create_worktree(&locks, spec("pane-2", 2)).expect("second create");

        assert_eq!(first.branch, "kd/ws/1");
        assert_eq!(second.branch, "kd/ws/1-2");
        assert_eq!(first.path, wt(1).to_string_lossy());
        assert_eq!(second.path, wt(2).to_string_lossy());
        let _ = std::fs::remove_dir_all(wt(1));
        let _ = std::fs::remove_dir_all(wt(2));
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
        // The visitor carries a TRUSTED source (explicit HEAD) and sits on the
        // same commit as everything else — so the timestamp separation below
        // is the ONE guard this test isolates.
        git_at(&repo, 1_700_000_000, &["branch", "visitor", "HEAD"]);
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
    fn sweep_without_in_use_info_attempts_only_the_tracked_branch() {
        // `worktree list` failed: extras are kept (deleting blind could hit
        // an in-use branch); the tracked branch is still attempted, unguarded.
        let targets = sweep_targets(Some("kd/ws/1"), &["kd/side"], None);
        assert_eq!(targets, ["kd/ws/1"]);
        assert!(sweep_targets(None, &["kd/side"], None).is_empty());
    }

    #[test]
    fn sweep_with_in_use_info_shields_adopted_branches_everywhere() {
        let adopted: HashSet<String> = ["kd/side".to_string(), "kd/ws/1".to_string()].into();
        // The guard applies to extras AND the tracked branch alike.
        assert_eq!(
            sweep_targets(Some("kd/ws/1"), &["kd/side", "kd/free"], Some(&adopted)),
            ["kd/free"]
        );
        // With nothing adopted, everything is swept, tracked branch first.
        assert_eq!(
            sweep_targets(Some("kd/ws/1"), &["kd/side"], Some(&HashSet::new())),
            ["kd/ws/1", "kd/side"]
        );
    }

    #[test]
    fn create_resolves_a_branch_name_base_so_provenance_trusts_the_birth() {
        // The "+ Agent" dialog sends the base as a branch NAME. Passed through
        // verbatim it would be recorded as a name-sourced creation — untrusted
        // by provenance — and the born branch would never be attributed back.
        let repo = init_repo("name-base");
        let current = git_out(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .trim()
            .to_string();
        let base_sha = keepdeck_git::repo::resolve_commit(&repo, &current).unwrap();
        let target = repo.with_file_name(format!(
            "{}-wt",
            repo.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&target);

        let record = create_worktree(
            &RepoLocks::default(),
            CreateSpec {
                repo: repo.to_string_lossy().into_owned(),
                agent_id: "pane-1".to_string(),
                branch: None,
                base: Some(current.clone()),
                base_branch: None,
                workspace: "ws".to_string(),
                index: 1,
                path: target.to_string_lossy().into_owned(),
            },
        )
        .expect("create with a branch-name base");

        // The branch's OWN creation record is what this test is about: a
        // name-sourced one ("branch: Created from main") is refused by
        // provenance's trust rule, a sha-sourced one is accepted.
        //
        // Asserting through `created_branches` instead would drag in the
        // timestamp pairing, which is a different rule and an inherently racy
        // one: `git worktree add -b` writes the branch ref and the worktree's
        // HEAD as two ref updates stamping whole seconds of their own, so a
        // create that straddles a tick fails to pair. That made this test
        // flaky under the parallel suite (3 failures in 10 runs) while saying
        // nothing about the base resolution it is named for. The pairing is
        // unit-tested against hand-built reflogs in `provenance`.
        let source = git_out(&repo, &["log", "-g", "--format=%gs", &record.branch])
            .lines()
            .last()
            .map(|line| {
                line.trim()
                    .strip_prefix("branch: Created from ")
                    .map(str::to_string)
            });
        let metadata =
            worktree_base::read(Path::new(&record.path)).expect("read private base metadata");

        // Swept before ANY assertion or unwrap below, so no failure mode
        // leaves the repo and its worktree behind — and so the sweep happens
        // even when the parse, not the rule, is what went wrong.
        let _ = std::fs::remove_dir_all(&target);
        let _ = std::fs::remove_dir_all(&repo);

        let source = source
            .expect("the branch has a creation reflog entry")
            .expect("created, not moved");
        // The same widths `head::is_commit_sha` trusts — SHA-1 and SHA-256.
        // Asserting only 40 would fail a correct build on a sha256 repo and
        // point at "base resolution", which would not be the problem.
        assert!(
            matches!(source.len(), 40 | 64)
                && source.chars().all(|c| c.is_ascii_hexdigit()),
            "base reached git as {source:?}, not a resolved commit sha",
        );
        assert_eq!(
            metadata,
            worktree_base::BaseMetadata {
                branch_ref: Some(format!("refs/heads/{current}")),
                at_creation: Some(base_sha),
                managed_branch_ref: Some(format!("refs/heads/{}", record.branch)),
            }
        );
    }

    #[test]
    fn a_pinned_sha_retains_branch_identity_after_rebase() {
        let repo = init_repo("pinned-base-identity");
        let current = git_out(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .trim()
            .to_string();
        let base_sha = keepdeck_git::repo::resolve_commit(&repo, &current).unwrap();
        let target = repo.with_file_name(format!(
            "{}-wt",
            repo.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&target);

        let record = create_worktree(
            &RepoLocks::default(),
            CreateSpec {
                repo: repo.to_string_lossy().into_owned(),
                agent_id: "pane-1".to_string(),
                branch: Some("kd/batch/1".to_string()),
                base: Some(base_sha.clone()),
                base_branch: Some(current.clone()),
                workspace: "ws".to_string(),
                index: 1,
                path: target.to_string_lossy().into_owned(),
            },
        )
        .expect("create from a separately pinned base");
        let agent = PathBuf::from(&record.path);

        std::fs::write(agent.join("agent.txt"), "agent\n").unwrap();
        git(&agent, &["add", "."]);
        git(&agent, &["commit", "-q", "-m", "agent work"]);
        std::fs::write(repo.join("main.txt"), "main\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "main moves"]);
        let new_main = keepdeck_git::repo::resolve_commit(&repo, &current).unwrap();
        git(&agent, &["rebase", "-q", &current]);

        let metadata = worktree_base::read(&agent).expect("read metadata");
        let fork = metadata
            .fork_point(&agent, "HEAD")
            .expect("resolve dynamic fork");
        assert_eq!(metadata.branch_ref, Some(format!("refs/heads/{current}")));
        assert_eq!(metadata.at_creation, Some(base_sha));
        assert_eq!(
            metadata.managed_branch_ref,
            Some("refs/heads/kd/batch/1".to_string())
        );
        assert_eq!(fork, Some(new_main));

        let _ = std::fs::remove_dir_all(&target);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn exact_path_creation_records_private_base_metadata() {
        let repo = init_repo("exact-path-metadata");
        let current = git_out(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .trim()
            .to_string();
        let base_sha = keepdeck_git::repo::resolve_commit(&repo, &current).unwrap();
        let target = repo.with_file_name(format!(
            "{}-exact-wt",
            repo.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&target);

        let record = create_worktree(
            &RepoLocks::default(),
            CreateSpec {
                repo: repo.to_string_lossy().into_owned(),
                agent_id: "pane-exact".to_string(),
                branch: Some("kd/exact/1".to_string()),
                base: Some(current.clone()),
                base_branch: None,
                workspace: "ws".to_string(),
                index: 1,
                path: target.to_string_lossy().into_owned(),
            },
        )
        .expect("exact-path create");

        let metadata = worktree_base::read(Path::new(&record.path)).expect("read metadata");
        assert_eq!(
            metadata,
            worktree_base::BaseMetadata {
                branch_ref: Some(format!("refs/heads/{current}")),
                at_creation: Some(base_sha),
                managed_branch_ref: Some("refs/heads/kd/exact/1".to_string()),
            }
        );

        let _ = std::fs::remove_dir_all(&target);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn metadata_failure_rolls_back_the_new_worktree_and_branch() {
        let repo = init_repo("metadata-rollback");
        let base = keepdeck_git::repo::resolve_commit(&repo, "HEAD").unwrap();
        let target = repo.with_file_name(format!(
            "{}-rollback-wt",
            repo.file_name().unwrap().to_string_lossy()
        ));
        let branch = "kd/rollback/1";
        let _ = std::fs::remove_dir_all(&target);

        let error = add_worktree_with_base(
            &repo,
            &target,
            branch,
            &base,
            Some("refs/heads/invalid branch"),
        )
        .expect_err("invalid symbolic base must fail");

        assert!(
            error.contains("could not record worktree base metadata"),
            "unexpected error: {error}"
        );
        assert!(!target.exists(), "partially-created worktree leaked");
        assert!(
            !keepdeck_git::repo::branch_exists(&repo, branch).unwrap(),
            "partially-created branch leaked"
        );
        let registrations = git_out(&repo, &["worktree", "list", "--porcelain"]);
        assert!(
            !registrations.contains("-rollback-wt"),
            "worktree registration leaked:\n{registrations}"
        );

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn metadata_failure_rolls_back_a_sha256_worktree_and_branch() {
        let Some(repo) = init_sha256_repo("metadata-rollback-sha256") else {
            return;
        };
        let base = keepdeck_git::repo::resolve_commit(&repo, "HEAD").unwrap();
        assert_eq!(base.len(), 64, "fixture must use SHA-256 object ids");
        let target = repo.with_file_name(format!(
            "{}-rollback-wt",
            repo.file_name().unwrap().to_string_lossy()
        ));
        let branch = "kd/rollback-sha256/1";
        let _ = std::fs::remove_dir_all(&target);

        let error = add_worktree_with_base(
            &repo,
            &target,
            branch,
            &base,
            Some("refs/heads/invalid branch"),
        )
        .expect_err("invalid symbolic base must fail");

        assert!(
            error.contains("could not record worktree base metadata"),
            "unexpected error: {error}"
        );
        assert!(!target.exists(), "partially-created worktree leaked");
        assert!(
            !keepdeck_git::repo::branch_exists(&repo, branch).unwrap(),
            "partially-created branch leaked"
        );

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_with_reap_recovers_branches_of_an_externally_deleted_worktree() {
        // The dir vanished behind KeepDeck's back, but the admin record still
        // holds the provenance until prune — the reap must survive the same
        // external deletion that the registration/tracked-branch fallthrough
        // (a distinct, older mechanism in remove_worktree) already handles.
        let (repo, wt, branch) = repo_with_worktree("reap-gone");
        git(&wt, &["switch", "-q", "-c", "kd/side-branch"]);
        git(&wt, &["switch", "-q", &branch]);
        std::fs::remove_dir_all(&wt).unwrap();

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
        .expect("a gone dir must not abort the reap");

        for gone in [branch.as_str(), "kd/side-branch"] {
            let out = git_out(&repo, &["branch", "--list", gone]);
            assert!(out.trim().is_empty(), "branch leaked: {gone}");
        }
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

    #[cfg(unix)]
    #[test]
    fn clear_husk_deletes_the_leftovers_and_tolerates_a_gone_path() {
        let husk = std::env::temp_dir().join(format!("keepdeck-husk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&husk);
        // The shape a half-finished removal leaves: our own arming symlink, a
        // nested directory, and git's `.git` pointer file.
        std::fs::create_dir_all(husk.join(".agents")).unwrap();
        std::os::unix::fs::symlink("/tmp", husk.join(".agents").join("skills")).unwrap();
        std::fs::write(husk.join(".git"), "gitdir: /nowhere").unwrap();

        clear_husk(&husk).expect("a leftover we can delete must be deleted");
        assert!(!husk.exists());
        clear_husk(&husk).expect("already gone is not a failure");
    }

    #[test]
    fn husk_verdict_fires_only_on_a_registration_that_provably_vanished() {
        // The verdict authorizes deleting a directory, so only ONE of the nine
        // combinations may say yes. "Could not tell" is the dangerous input:
        // read as "deregistered", it would finish a delete on a worktree git
        // left whole.
        assert!(husk_verdict(Some(true), Some(false)));
        for pair in [
            (Some(true), None),
            (Some(true), Some(true)),
            (None, Some(false)),
            (None, None),
            (None, Some(true)),
            (Some(false), Some(false)),
            (Some(false), None),
            (Some(false), Some(true)),
        ] {
            assert!(!husk_verdict(pair.0, pair.1), "{pair:?} must not delete");
        }
    }

    /// A worktree whose subdirectory git cannot unlink: the removal fails for
    /// real, and git drops the administrative record anyway. The returned guard
    /// owns BOTH temp directories and restores the permission on any exit, so a
    /// failing assertion — or an early return on a machine where the permission
    /// does not bite — cannot leak a directory `rm -rf` is unable to clear.
    #[cfg(unix)]
    fn repo_with_undeletable_worktree(label: &str) -> (PathBuf, Unlockable, String) {
        use std::os::unix::fs::PermissionsExt;
        let repo = init_repo(label);
        // COMMITTED, not just present: an untracked file would trip our own
        // dirty check before a non-force removal ever reached git, and it is
        // git's unlink that has to be the thing that fails here.
        std::fs::create_dir_all(repo.join("locked")).unwrap();
        std::fs::write(repo.join("locked").join("f"), "x").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "locked"]);

        let branch = format!("kd/{label}/1");
        let wt = repo.with_file_name(format!(
            "{}-wt",
            repo.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&wt);
        git(&repo, &["worktree", "add", "-q", "-b", &branch, wt.to_str().unwrap()]);
        std::fs::set_permissions(wt.join("locked"), std::fs::Permissions::from_mode(0o555))
            .unwrap();
        (
            repo.clone(),
            Unlockable {
                wt,
                repo: repo.clone(),
            },
            branch,
        )
    }

    /// Restores the 0o555 fixture on the way out, panic or not — the permission
    /// is what makes the leftover undeletable, so leaking it poisons the temp
    /// dir for every later run that draws the same pid.
    #[cfg(unix)]
    struct Unlockable {
        wt: PathBuf,
        repo: PathBuf,
    }

    #[cfg(unix)]
    impl Drop for Unlockable {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                self.wt.join("locked"),
                std::fs::Permissions::from_mode(0o755),
            );
            let _ = std::fs::remove_dir_all(&self.wt);
            // The repo too: a test that bails out early (running as root) would
            // otherwise leave it, and the next run drawing the same pid trips
            // over the leftover with a message about git.
            let _ = std::fs::remove_dir_all(&self.repo);
        }
    }

    /// Does the 0o555 fixture actually stop a write? It does not for root, and a
    /// test that leans on the permission would then assert the opposite of what
    /// happens. Probing the property beats probing the uid: it is the property
    /// the fixture needs.
    #[cfg(unix)]
    fn write_is_blocked(dir: &Path) -> bool {
        let probe = dir.join("probe");
        match std::fs::write(&probe, "x") {
            Ok(()) => {
                let _ = std::fs::remove_file(&probe);
                false
            }
            Err(_) => true,
        }
    }

    #[cfg(unix)]
    #[test]
    fn remove_keeps_an_unforced_husk_but_still_reaps_the_registration_and_branch() {
        // Git can abandon its recursion having unlinked NOTHING, so the leftover
        // may still hold the user's files. Without `force` the directory stays;
        // the registration and the branch — which git already dropped or made
        // unreachable — must be cleaned up regardless.
        let (repo, wt, branch) = repo_with_undeletable_worktree("husk-unforced");
        if !write_is_blocked(&wt.wt.join("locked")) {
            return; // running as root: git would not fail, so there is no husk
        }

        let result = remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: wt.wt.to_string_lossy().into_owned(),
                force: false,
                branch: Some(branch.clone()),
                reap_created_branches: false,
            },
        );

        let message = result.expect_err("a kept leftover must be reported");
        assert!(
            message.contains("needs a forced removal"),
            "the reason was not explained: {message}"
        );
        assert!(wt.wt.join("locked").join("f").exists(), "files were destroyed");
        let list = git_out(&repo, &["worktree", "list", "--porcelain"]);
        assert!(!list.contains("-wt"), "registration leaked:\n{list}");
        let branches = git_out(&repo, &["branch", "--list", &branch]);
        assert!(branches.trim().is_empty(), "branch leaked: {branches}");

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[cfg(unix)]
    #[test]
    fn remove_reaps_registration_and_branch_when_git_abandons_a_husk() {
        // THE regression: git deletes the administrative record even when the
        // directory delete fails, so bailing out here left an orphan `kd/…`
        // branch and a husk no `git worktree remove` could ever address.
        // An unwritable subdirectory makes git's recursive delete fail for
        // real, without depending on the timing that produced it in the wild
        // (staged-skills arming re-creating `.agents` mid-delete).
        let (repo, wt, branch) = repo_with_undeletable_worktree("husk");
        if !write_is_blocked(&wt.wt.join("locked")) {
            return; // running as root: git would not fail, so there is no husk
        }

        let result = remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: wt.wt.to_string_lossy().into_owned(),
                force: true,
                branch: Some(branch.clone()),
                reap_created_branches: false,
            },
        );

        // The undeletable directory is still reported — first, ahead of any
        // branch failures, since it is the primary one.
        let message = result.expect_err("an unremovable leftover must be reported");
        assert!(
            message.contains("leftover directory"),
            "leftover not reported: {message}"
        );
        // ...but the cleanup it used to abort now runs to the end.
        let list = git_out(&repo, &["worktree", "list", "--porcelain"]);
        assert!(!list.contains("-wt"), "registration leaked:\n{list}");
        let branches = git_out(&repo, &["branch", "--list", &branch]);
        assert!(branches.trim().is_empty(), "branch leaked: {branches}");

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_keeps_a_directory_whose_git_pointer_dangles() {
        // A `.git` pointer whose target is missing is NOT evidence that the
        // directory is ours to delete: a healthy submodule and any worktree
        // under `worktree.useRelativePaths` look exactly like this to a check
        // that resolves the pointer against the process cwd. A removal git
        // refuses must leave the directory alone, whatever its pointer says.
        let repo = init_repo("dangling-pointer");
        let stray = repo.with_file_name("keepdeck-dangling-dir");
        let _ = std::fs::remove_dir_all(&stray);
        std::fs::create_dir_all(&stray).unwrap();
        std::fs::write(stray.join("work.txt"), "mine").unwrap();
        std::fs::write(stray.join(".git"), "gitdir: /nowhere/.git/worktrees/x").unwrap();

        let result = remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: stray.to_string_lossy().into_owned(),
                force: true,
                branch: None,
                reap_created_branches: false,
            },
        );

        assert!(result.is_err(), "git refused, so nothing may be deleted");
        assert!(stray.join("work.txt").exists(), "work was destroyed");
        let _ = std::fs::remove_dir_all(&stray);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_keeps_a_live_submodule_aimed_at_by_a_forced_removal() {
        // The shape that made this a data-loss bug: git writes a submodule's
        // `.git` pointer RELATIVE to the file's own directory, so a check that
        // resolved it against the process cwd read a perfectly healthy submodule
        // as an abandoned leftover — and `git worktree remove` fails on it,
        // which was that check's precondition for deleting.
        let repo = init_repo("submodule-host");
        let lib = repo.with_file_name("keepdeck-submodule-lib");
        let _ = std::fs::remove_dir_all(&lib);
        std::fs::create_dir_all(&lib).unwrap();
        git(&lib, &["init", "-q"]);
        configure_repo(&lib);
        let added = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["-c", "protocol.file.allow=always", "submodule", "add", "-q"])
            .arg(&lib)
            .arg("vendor/sub")
            .status()
            .expect("run git");
        if !added.success() {
            let _ = std::fs::remove_dir_all(&lib);
            let _ = std::fs::remove_dir_all(&repo);
            return; // this git refuses local submodules outright; nothing to prove
        }
        let sub = repo.join("vendor").join("sub");
        std::fs::write(sub.join("mywork.txt"), "uncommitted").unwrap();
        let pointer = std::fs::read_to_string(sub.join(".git")).unwrap();
        assert!(pointer.contains("../"), "expected a relative pointer: {pointer}");

        let result = remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: sub.to_string_lossy().into_owned(),
                force: true,
                branch: None,
                reap_created_branches: false,
            },
        );

        assert!(result.is_err(), "a submodule is not a worktree to remove");
        assert!(sub.join("mywork.txt").exists(), "the submodule was destroyed");
        let _ = std::fs::remove_dir_all(&lib);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_refuses_a_directory_that_is_not_a_worktree() {
        // A plain directory the webview named: git refuses, and nothing else may
        // decide to delete it.
        let repo = init_repo("not-a-husk");
        let stray = repo.with_file_name("keepdeck-stray-dir");
        let _ = std::fs::remove_dir_all(&stray);
        std::fs::create_dir_all(&stray).unwrap();
        std::fs::write(stray.join("work.txt"), "mine").unwrap();

        let result = remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: stray.to_string_lossy().into_owned(),
                force: true,
                branch: None,
                reap_created_branches: false,
            },
        );

        assert!(result.is_err(), "a stray directory must not be removed");
        assert!(stray.join("work.txt").exists(), "work was destroyed");
        let _ = std::fs::remove_dir_all(&stray);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_keeps_the_worktree_when_git_refuses_outright() {
        // The other side of the husk rule: a git that refuses BEFORE touching
        // anything (here, a locked worktree — that needs `--force` twice) must
        // abort the whole removal. Deleting the directory ourselves or reaping
        // the branch would destroy a worktree git deliberately spared.
        let (repo, wt, branch) = repo_with_worktree("refused");
        git(&repo, &["worktree", "lock", wt.to_str().unwrap()]);

        let result = remove_worktree(
            &RepoLocks::default(),
            RemoveSpec {
                repo: repo.to_string_lossy().into_owned(),
                path: wt.to_string_lossy().into_owned(),
                force: true,
                branch: Some(branch.clone()),
                reap_created_branches: false,
            },
        );

        assert!(result.is_err(), "a refused removal must surface");
        assert!(wt.join(".git").exists(), "the worktree was destroyed");
        let list = git_out(&repo, &["worktree", "list", "--porcelain"]);
        assert!(list.contains("-wt"), "registration was dropped:\n{list}");
        let branches = git_out(&repo, &["branch", "--list", &branch]);
        assert!(!branches.trim().is_empty(), "branch was reaped: {branches}");

        git(&repo, &["worktree", "unlock", wt.to_str().unwrap()]);
        let _ = std::fs::remove_dir_all(&wt);
        let _ = std::fs::remove_dir_all(&repo);
    }
}
