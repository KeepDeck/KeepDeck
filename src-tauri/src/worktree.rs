//! Worktree delivery layer: bridges the `keepdeck-git` domain crate to the
//! app. Clean-architecture boundary — this adapter depends on `keepdeck-git`,
//! never the reverse.
//!
//! Two kinds of callers. The webview reads through the `worktree_*` query
//! commands (probe, inspect, list, branches). The lifecycle machine's git
//! doors create and remove worktrees and branches, each one step of an
//! operation it journaled. WHEN to create or remove is the machine's alone.
//! Every write takes the repository's lock ([`RepoLocks`], Tauri managed
//! state), since concurrent git writes race on the shared `.git` locks.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use keepdeck_git::{branch, provenance, repo, worktree, worktree_base};
use serde::Serialize;

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

/// One of a repository's checkouts, as the Workspaces window lists them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub locked: bool,
    /// Its directory is gone; only git's record of it is left.
    pub prunable: bool,
    /// Entries `git status` calls changed — `None` when that could not be
    /// asked (a directory that is gone, a git that failed). Never a silent 0.
    pub changed: Option<usize>,
}

/// Every checkout of `repo`, from `git worktree list`, with how much
/// uncommitted work each holds. `(async)`: it shells out to git per row.
#[tauri::command(async)]
pub fn worktree_list(repo: String) -> Result<Vec<ListedWorktree>, String> {
    let path = Path::new(&repo);
    if !repo::is_git_repo(path) {
        return Err(format!("not a git repository: {repo}"));
    }
    list_worktrees(path)
}

/// [`worktree_list`] body.
fn list_worktrees(repo: &Path) -> Result<Vec<ListedWorktree>, String> {
    let rows = worktree::list(repo).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter(|row| !row.bare)
        .map(|row| {
            let changed = if row.prunable || !row.path.exists() {
                None
            } else {
                worktree::changed_entries(&row.path).ok()
            };
            ListedWorktree {
                path: row.path.to_string_lossy().into_owned(),
                branch: row.branch,
                head: row.head,
                detached: row.detached,
                locked: row.locked,
                prunable: row.prunable,
                changed,
            }
        })
        .collect())
}

/// Keep the commit a checkout stands on as `refs/tags/<name>` — asked before
/// a detached checkout is removed, so the commits only it holds are not left
/// for git to collect. Refuses a name already taken rather than moving it.
fn save_head(repo: &Path, path: &Path, name: &str) -> Result<String, String> {
    let rows = worktree::list(repo).map_err(|e| e.to_string())?;
    let head = rows
        .into_iter()
        .find(|row| worktree::paths_match(&row.path, path))
        .and_then(|row| row.head)
        .ok_or_else(|| format!("{} is not a checkout of this repository with a commit", path.display()))?;
    let reference = format!("refs/tags/{name}");
    // `update-ref` with an all-zero old value creates the ref only if it does
    // not exist yet: a name in use is refused, never moved.
    let zero = "0".repeat(head.len());
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["update-ref", &reference, &head, &zero])
        .output()
        .map_err(|e| e.to_string())?;
    if !status.status.success() {
        return Err(format!(
            "could not keep {} as tag {name}: {}",
            &head[..head.len().min(7)],
            String::from_utf8_lossy(&status.stderr).trim()
        ));
    }
    Ok(reference)
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

/// The commit a new worktree starts at, and the local branch it was picked
/// as, if one was.
///
/// The base is ALWAYS pinned to a commit sha — a picked branch NAME must not
/// flow into `worktree add -b` verbatim: git would record a name-sourced
/// creation, which reflog provenance deliberately refuses to trust, and the
/// born branch would never be attributed back to its worktree at close time.
/// Pinning also keeps a whole batch on one commit even if the base moves
/// mid-batch. The local branch identity is retained separately in a private
/// base ref for dynamic fork-point resolution.
fn resolve_base(repo_path: &Path, base: Option<&str>, base_branch: Option<&str>) -> Result<(String, Option<String>), String> {
    let base_rev = base.map(str::trim).filter(|s| !s.is_empty());
    let has_explicit_base = base_rev.is_some();
    let base_rev = base_rev.unwrap_or("HEAD");
    let named_branch = base_branch.map(str::trim).filter(|branch| !branch.is_empty());
    let base_branch_rev = named_branch.unwrap_or(base_rev);
    let base_branch_ref = repo::local_branch_ref(repo_path, base_branch_rev)
        .map_err(|e| format!("cannot identify base branch: {e}"))?;
    if named_branch.is_some() && base_branch_ref.is_none() {
        return Err(format!("cannot identify local base branch '{base_branch_rev}'"));
    }
    let base = repo::resolve_commit(repo_path, base_rev).map_err(|e| match base_rev {
        "HEAD" if !has_explicit_base => e.to_string(),
        rev => format!("cannot resolve base '{rev}': {e}"),
    })?;
    Ok((base, base_branch_ref))
}

// ── The lifecycle machine's git doors ───────────────────────────────────
//
// Each is one step of an operation the machine journaled, carried out under
// the repository's lock. They decide nothing: what to create or remove, and
// with what consent, is the machine's plan.

/// Whether something is on disk at a candidate place: a folder with anything
/// in it, or a branch of that name. An empty folder is a free place, as git
/// can create a worktree into one. A git that cannot answer says "taken" —
/// a place is never handed out on a guess.
pub(crate) fn place_taken(repo: &Path, path: &Path, branch: &str) -> bool {
    let folder = path.exists() && std::fs::read_dir(path).map(|mut entries| entries.next().is_some()).unwrap_or(true);
    folder || repo::branch_exists(repo, branch).unwrap_or(true)
}

/// Create a ticket's worktree: on the branch the ticket names — never
/// another — from its base, pinned. A checkout already at the ticket's path
/// on that branch is this ticket's (an add that finished before its result
/// was recorded) and is picked up; anything else there is refused.
pub(crate) fn create_by_ticket(locks: &RepoLocks, repo_path: &Path, path: &Path, branch: &str, base: Option<&str>) -> Result<(), String> {
    if !repo::is_git_repo(repo_path) {
        return Err(format!("not a git repository: {}", repo_path.display()));
    }
    let (base, base_branch_ref) = resolve_base(repo_path, base, None)?;
    let lock = locks.for_repo(repo_path);
    let _guard = locks.acquire(&lock);
    if ticket_checkout_stands(repo_path, path, branch)? {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create worktree parent dir: {e}"))?;
    }
    add_worktree_with_base(repo_path, path, branch, &base, base_branch_ref.as_deref())
}

/// Whether a ticket's checkout stands — git's word, nothing made: a
/// checkout of the repository at the ticket's path, on its branch. What a
/// close may then delete as this ticket's.
pub(crate) fn find_by_ticket(locks: &RepoLocks, repo_path: &Path, path: &Path, branch: &str) -> Result<(), String> {
    let lock = locks.for_repo(repo_path);
    let _guard = locks.acquire(&lock);
    if ticket_checkout_stands(repo_path, path, branch)? {
        Ok(())
    } else {
        Err(format!("no checkout of {branch} stands at {}", path.display()))
    }
}

/// A checkout of the repository at `path` on `branch` is a ticket's: an add
/// that finished, its result recorded or not. A checkout of anything else
/// there is refused; none there is `false`.
fn ticket_checkout_stands(repo_path: &Path, path: &Path, branch: &str) -> Result<bool, String> {
    let here = worktree::list(repo_path)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|row| worktree::paths_match(&row.path, path));
    match here.map(|row| row.branch) {
        None => Ok(false),
        Some(Some(found)) if found == branch => Ok(true),
        Some(other) => Err(format!("{} is a checkout of {} already, not of {branch}", path.display(), other.as_deref().unwrap_or("a detached HEAD"))),
    }
}

/// The branches born in a checkout, read from its reflog — before it is
/// removed, which erases that evidence. A checkout that is not there is an
/// error: the plan then records it absent.
pub(crate) fn born_branches(locks: &RepoLocks, repo_path: &Path, path: &Path) -> Result<Vec<String>, String> {
    let lock = locks.for_repo(repo_path);
    let _guard = locks.acquire(&lock);
    if !path.exists() && is_registered_worktree(repo_path, path) != Some(true) {
        return Err(format!("{} is not a checkout of {}", path.display(), repo_path.display()));
    }
    provenance::created_branches(repo_path, path).map_err(|e| e.to_string())
}

/// Remove a checkout by its plan. The consent covers its uncommitted work; a
/// checkout already gone is removed; a leftover git could not finish is a
/// step not done.
pub(crate) fn remove_planned_checkout(locks: &RepoLocks, repo_path: &Path, path: &Path) -> Result<(), String> {
    let lock = locks.for_repo(repo_path);
    let _guard = locks.acquire(&lock);
    match remove_checkout(repo_path, path)? {
        None => Ok(()),
        Some(leftover) => Err(leftover),
    }
}

/// Delete a branch the consent covers, under git's own ref lock. A branch
/// checked out elsewhere is somebody's and is kept; one already gone is done.
pub(crate) fn remove_planned_branch(locks: &RepoLocks, repo_path: &Path, name: &str) -> Result<(), String> {
    let lock = locks.for_repo(repo_path);
    let _guard = locks.acquire(&lock);
    let in_use = worktree::list(repo_path).map_err(|e| e.to_string())?.into_iter().any(|row| row.branch.as_deref() == Some(name));
    if in_use {
        log::warn!("worktree: branch '{name}' is checked out in another worktree of {}; keeping it", repo_path.display());
        return Ok(());
    }
    delete_branch_if_present(repo_path, name)
}

/// Keep a checkout's HEAD as a tag before it goes; a name in use is refused.
pub(crate) fn tag_head(repo_path: &Path, path: &Path, name: &str) -> Result<(), String> {
    save_head(repo_path, path, name).map(drop)
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

/// Remove the checkout at `path` and its registration, its uncommitted work
/// included — the consent covers it. The caller holds the repository's lock.
/// `Ok(Some(why))`: git deregistered the checkout but a leftover directory
/// would not go; `Err`: git refused before touching anything, and the
/// checkout is intact.
///
/// A checkout already gone must never abort: there is no work left to lose,
/// and bailing out would leak the `.git` registration forever, so a failed
/// `git worktree remove` on a gone directory falls through to `prune`. A
/// removal git ABANDONED MIDWAY is finished the same way ([`husk_verdict`]):
/// the registration is gone either way, so the leftover directory goes too.
/// Only a git that refused before touching anything stops it.
fn remove_checkout(repo_path: &Path, path: &Path) -> Result<Option<String>, String> {
    // Read BEFORE the removal: half the evidence [`husk_verdict`] needs to tell
    // a git that refused from a git that gave up midway.
    let registered = is_registered_worktree(repo_path, path);

    let mut leftover = None;
    match worktree::remove(repo_path, path, true) {
        Ok(()) => {}
        // Git refuses to `remove` a worktree whose dir is already gone; only a
        // failure with the dir still present is a real error.
        Err(_) if !path.exists() => {}
        Err(e) if husk_verdict(registered, is_registered_worktree(repo_path, path)) => {
            // Git deregistered the directory, so no later `git worktree remove`
            // can address it and the prune below must run either way. Git can
            // abandon having unlinked nothing at all — a subdirectory it cannot
            // enter aborts its recursion where it stands — and the consent
            // covers every file the leftover still holds.
            leftover = clear_husk(path).err().map(|why| format!("{e}; {why}"));
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
    if let Err(e) = worktree::prune(repo_path) {
        log::warn!("worktree: prune after remove failed in {}: {e}", repo_path.display());
    }
    Ok(leftover)
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

/// Delete `branch`, its unmerged commits included — the consent covers them —
/// unless it's already gone: someone beating us to it means already-cleaned,
/// not failed. `Err` carries the words for what resisted.
fn delete_branch_if_present(repo_path: &Path, branch: &str) -> Result<(), String> {
    match repo::branch_exists(repo_path, branch) {
        Ok(true) => repo::delete_branch(repo_path, branch, true).map_err(|e| {
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
        // The machine's global excludes must not reach into the stand.
        git(dir, &["config", "core.excludesfile", ""]);
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

    /// A removal as the lifecycle plans it: the born branches read first, then
    /// the checkout, then each branch — the order the machine's steps run in.
    fn planned_removal(repo: &Path, wt: &Path, branches: &[&str]) -> Result<(), String> {
        let locks = RepoLocks::default();
        remove_planned_checkout(&locks, repo, wt)?;
        for branch in branches {
            remove_planned_branch(&locks, repo, branch)?;
        }
        Ok(())
    }

    #[test]
    fn a_planned_removal_reaps_registration_and_branch_when_the_dir_was_deleted_externally() {
        // The dir vanished behind KeepDeck's back (manual rm, cleanup tool).
        // `git worktree remove` refuses a gone dir — the removal must fall
        // through to prune instead of aborting, or the .git registration and
        // the kd/ branch leak forever.
        let (repo, wt, branch) = repo_with_worktree("reap-forced");
        std::fs::remove_dir_all(&wt).unwrap();

        planned_removal(&repo, &wt, &[&branch]).expect("a gone dir must not abort the removal");

        let list = git_out(&repo, &["worktree", "list", "--porcelain"]);
        assert!(!list.contains("-wt"), "registration leaked:\n{list}");
        let branches = git_out(&repo, &["branch", "--list", &branch]);
        assert!(branches.trim().is_empty(), "branch leaked: {branches}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_planned_removal_succeeds_when_the_branch_is_already_gone() {
        // If the user switched to another branch and deleted ours, the worktree
        // folder is still removed and the cleanup is considered successful.
        let (repo, wt, branch) = repo_with_worktree("branch-gone");
        git(&wt, &["checkout", "-b", "tmp"]); // move the worktree off our branch
        git(&repo, &["branch", "-D", &branch]); // now the branch can be deleted

        planned_removal(&repo, &wt, &[&branch]).expect("removal must succeed when the branch is already gone");

        assert!(!wt.exists(), "worktree dir must be removed");
        let list = git_out(&repo, &["worktree", "list", "--porcelain"]);
        assert!(!list.contains("-wt"), "registration leaked:\n{list}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_planned_removal_takes_the_branches_born_in_the_worktree_and_leaves_a_visitor() {
        // The agent made a side branch during its session; the close's consent
        // covers it along with the tracked branch, while a branch that merely
        // VISITED the worktree stays.
        let (repo, wt, branch) = repo_with_worktree("reap-created");
        // The visitor carries a TRUSTED source (explicit HEAD) and sits on the
        // same commit as everything else — so the timestamp separation below
        // is the ONE guard this test isolates.
        git_at(&repo, 1_700_000_000, &["branch", "visitor", "HEAD"]);
        git(&wt, &["switch", "-q", "-c", "kd/side-branch"]);
        git(&wt, &["switch", "-q", "visitor"]);

        let born = born_branches(&RepoLocks::default(), &repo, &wt).expect("read");
        assert!(born.contains(&"kd/side-branch".to_string()) && !born.contains(&"visitor".to_string()), "{born:?}");
        let mut plan: Vec<&str> = born.iter().map(String::as_str).collect();
        if !plan.contains(&branch.as_str()) {
            plan.push(&branch);
        }
        planned_removal(&repo, &wt, &plan).expect("removed by plan");

        for gone in [branch.as_str(), "kd/side-branch"] {
            let out = git_out(&repo, &["branch", "--list", gone]);
            assert!(out.trim().is_empty(), "branch leaked: {gone}");
        }
        let visitor = git_out(&repo, &["branch", "--list", "visitor"]);
        assert!(!visitor.trim().is_empty(), "the visiting branch was reaped");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_ticket_resolves_a_branch_name_base_so_provenance_trusts_the_birth() {
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

        let branch = "kd/ws/1";
        create_by_ticket(&RepoLocks::default(), &repo, &target, branch, Some(&current)).expect("create with a branch-name base");

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
        let source = git_out(&repo, &["log", "-g", "--format=%gs", branch])
            .lines()
            .last()
            .map(|line| {
                line.trim()
                    .strip_prefix("branch: Created from ")
                    .map(str::to_string)
            });
        let metadata = worktree_base::read(&target).expect("read private base metadata");

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
                managed_branch_ref: Some(format!("refs/heads/{branch}")),
            }
        );
    }

    #[test]
    fn a_ticket_from_a_branch_keeps_its_identity_after_a_rebase() {
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

        create_by_ticket(&RepoLocks::default(), &repo, &target, "kd/batch/1", Some(&current)).expect("create from a branch base");
        let agent = target.clone();

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
    fn the_born_branches_of_an_externally_deleted_worktree_are_still_read() {
        // The dir vanished behind KeepDeck's back, but the admin record still
        // holds the provenance until prune — the plan's read survives the same
        // external deletion the checkout step falls through.
        let repo = init_repo("reap-gone");
        let branch = "kd/reap-gone/1".to_string();
        let wt = repo.with_file_name(format!("{}-wt", repo.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&wt);
        git_at(&repo, 1_700_000_000, &["worktree", "add", "-q", "-b", &branch, wt.to_str().unwrap()]);
        git_at(&wt, 1_700_000_100, &["switch", "-q", "-c", "kd/side-branch"]);
        git_at(&wt, 1_700_000_200, &["switch", "-q", &branch]);
        std::fs::remove_dir_all(&wt).unwrap();

        let born = born_branches(&RepoLocks::default(), &repo, &wt).expect("read from the admin record");
        assert!(born.contains(&"kd/side-branch".to_string()), "{born:?}");
        let plan: Vec<&str> = born.iter().map(String::as_str).collect();
        planned_removal(&repo, &wt, &plan).expect("a gone dir must not abort the removal");
        for gone in [branch.as_str(), "kd/side-branch"] {
            let out = git_out(&repo, &["branch", "--list", gone]);
            assert!(out.trim().is_empty(), "branch leaked: {gone}");
        }
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn lists_every_checkout_with_its_changed_entries() {
        let (repo, wt, branch) = repo_with_worktree("list-changed");
        std::fs::write(wt.join("wip.txt"), "uncommitted").unwrap();
        std::fs::create_dir_all(wt.join("new/dir")).unwrap();
        std::fs::write(wt.join("new/dir/a.txt"), "a").unwrap();

        let rows = list_worktrees(&repo).expect("listed");

        assert_eq!(rows.len(), 2, "the main checkout and the linked one");
        let linked = rows.iter().find(|row| row.branch.as_deref() == Some(branch.as_str())).expect("the linked row");
        // A file and an untracked directory: two entries, as git counts them.
        assert_eq!(linked.changed, Some(2));
        assert!(!linked.prunable && !linked.detached);
        let main = rows.iter().find(|row| row.branch.as_deref() != Some(branch.as_str())).expect("the main row");
        assert_eq!(main.changed, Some(0));
        let _ = std::fs::remove_dir_all(&wt);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_checkout_whose_folder_is_gone_is_prunable_and_its_changes_unknown() {
        let (repo, wt, branch) = repo_with_worktree("list-gone");
        std::fs::remove_dir_all(&wt).unwrap();

        let rows = list_worktrees(&repo).expect("listed");

        let gone = rows.iter().find(|row| row.branch.as_deref() == Some(branch.as_str())).expect("the gone row");
        assert!(gone.prunable);
        assert_eq!(gone.changed, None, "unknown, never a silent 0");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn keeps_a_checkouts_commit_as_a_tag_and_never_moves_one_already_there() {
        let (repo, wt, _branch) = repo_with_worktree("save-head");
        std::fs::write(wt.join("f.txt"), "work").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-q", "-m", "only here"]);
        git(&wt, &["checkout", "-q", "--detach"]);
        let tip = git_out(&wt, &["rev-parse", "HEAD"]).trim().to_string();

        let saved = save_head(&repo, &wt, "archive/test/save-head").expect("saved");
        assert_eq!(saved, "refs/tags/archive/test/save-head");
        assert_eq!(git_out(&repo, &["rev-parse", "archive/test/save-head"]).trim(), tip);

        // Taken: refused, and the tag stays where it was.
        git(&wt, &["commit", "-q", "--allow-empty", "-m", "moved on"]);
        assert!(save_head(&repo, &wt, "archive/test/save-head").is_err());
        assert_eq!(git_out(&repo, &["rev-parse", "archive/test/save-head"]).trim(), tip);
        let _ = std::fs::remove_dir_all(&wt);
        let _ = std::fs::remove_dir_all(&repo);
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
    fn a_husk_git_abandoned_is_a_step_still_owed_and_its_branch_can_still_go() {
        // Git deletes the administrative record even when the directory delete
        // fails. The leftover stays owed — the step reports it — while the
        // registration is gone and the branch, no longer checked out anywhere,
        // goes on its own step. An unwritable subdirectory makes git's
        // recursive delete fail for real, without depending on the timing that
        // produced it in the wild (staged-skills arming re-creating `.agents`
        // mid-delete).
        let (repo, wt, branch) = repo_with_undeletable_worktree("husk");
        if !write_is_blocked(&wt.wt.join("locked")) {
            return; // running as root: git would not fail, so there is no husk
        }
        let locks = RepoLocks::default();

        let message = remove_planned_checkout(&locks, &repo, &wt.wt).expect_err("an unremovable leftover is still owed");
        assert!(message.contains("leftover directory"), "leftover not reported: {message}");
        let list = git_out(&repo, &["worktree", "list", "--porcelain"]);
        assert!(!list.contains("-wt"), "registration leaked:\n{list}");

        remove_planned_branch(&locks, &repo, &branch).expect("the branch is free to go");
        assert!(!branch_listed(&repo, &branch), "branch leaked");

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

        let result = remove_planned_checkout(&RepoLocks::default(), &repo, &stray);

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

        let result = remove_planned_checkout(&RepoLocks::default(), &repo, &sub);

        assert!(result.is_err(), "a submodule is not a worktree to remove");
        assert!(sub.join("mywork.txt").exists(), "the submodule was destroyed");
        let _ = std::fs::remove_dir_all(&lib);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_refuses_a_directory_that_is_not_a_worktree() {
        // A plain directory a plan named: git refuses, and nothing else may
        // decide to delete it.
        let repo = init_repo("not-a-husk");
        let stray = repo.with_file_name("keepdeck-stray-dir");
        let _ = std::fs::remove_dir_all(&stray);
        std::fs::create_dir_all(&stray).unwrap();
        std::fs::write(stray.join("work.txt"), "mine").unwrap();

        let result = remove_planned_checkout(&RepoLocks::default(), &repo, &stray);

        assert!(result.is_err(), "a stray directory must not be removed");
        assert!(stray.join("work.txt").exists(), "work was destroyed");
        let _ = std::fs::remove_dir_all(&stray);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn remove_keeps_the_worktree_when_git_refuses_outright() {
        // The other side of the husk rule: a git that refuses BEFORE touching
        // anything (here, a locked worktree — that needs `--force` twice)
        // leaves it whole. Deleting the directory ourselves would destroy a
        // worktree git deliberately spared, and its branch, still checked
        // out there, is kept by its own step.
        let (repo, wt, branch) = repo_with_worktree("refused");
        git(&repo, &["worktree", "lock", wt.to_str().unwrap()]);
        let locks = RepoLocks::default();

        let result = remove_planned_checkout(&locks, &repo, &wt);
        remove_planned_branch(&locks, &repo, &branch).expect("a branch in use is kept, not failed");

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

    // ── The lifecycle machine's git doors ───────────────────────────────

    fn branch_listed(repo: &Path, name: &str) -> bool {
        !git_out(repo, &["branch", "--list", name]).trim().is_empty()
    }

    #[test]
    fn a_place_is_free_only_with_no_folder_content_and_no_branch_of_its_name() {
        let repo = init_repo("door-probe");
        let place = repo.with_file_name(format!("{}-place", repo.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&place);
        assert!(!place_taken(&repo, &place, "kd/probe/1"), "nothing there");
        std::fs::create_dir_all(&place).unwrap();
        assert!(!place_taken(&repo, &place, "kd/probe/1"), "an empty folder takes a worktree");
        std::fs::write(place.join("x"), "x").unwrap();
        assert!(place_taken(&repo, &place, "kd/probe/1"), "a folder with something in it");
        std::fs::remove_dir_all(&place).unwrap();
        git(&repo, &["branch", "kd/probe/1"]);
        assert!(place_taken(&repo, &place, "kd/probe/1"), "a branch of the name");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_ticket_makes_its_own_branch_or_nothing_and_its_finished_checkout_is_picked_up() {
        let repo = init_repo("door-ticket");
        let locks = RepoLocks::default();
        let wt = repo.with_file_name(format!("{}-wt", repo.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&wt);

        create_by_ticket(&locks, &repo, &wt, "kd/ticket/1", None).expect("created");
        assert_eq!(git_out(&wt, &["branch", "--show-current"]).trim(), "kd/ticket/1");
        // A repeat after a lost result: the checkout is this ticket's.
        create_by_ticket(&locks, &repo, &wt, "kd/ticket/1", None).expect("picked up");
        // The same place for another branch is someone else's checkout.
        assert!(create_by_ticket(&locks, &repo, &wt, "kd/ticket/2", None).is_err());

        // A taken branch is never stepped over: the ticket names THE branch.
        let other = wt.with_file_name(format!("{}-other", wt.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&other);
        git(&repo, &["branch", "kd/ticket/3"]);
        assert!(create_by_ticket(&locks, &repo, &other, "kd/ticket/3", None).is_err());
        assert!(!other.join(".git").exists(), "nothing was made");
        assert!(!branch_listed(&repo, "kd/ticket/3-2"), "no stepped name");
        let _ = std::fs::remove_dir_all(&wt);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// Finding a ticket's checkout makes nothing: it stands at the ticket's
    /// path on the ticket's branch, or it is not this ticket's.
    #[test]
    fn a_tickets_checkout_is_found_only_where_it_stands_on_its_branch_and_never_made() {
        let repo = init_repo("door-find");
        let locks = RepoLocks::default();
        let wt = repo.with_file_name(format!("{}-wt", repo.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&wt);

        assert!(find_by_ticket(&locks, &repo, &wt, "kd/find/1").is_err(), "none stands");
        assert!(!wt.exists(), "nothing was made");
        assert!(!branch_listed(&repo, "kd/find/1"));
        create_by_ticket(&locks, &repo, &wt, "kd/find/1", None).expect("created");
        find_by_ticket(&locks, &repo, &wt, "kd/find/1").expect("this ticket's");
        assert!(find_by_ticket(&locks, &repo, &wt, "kd/find/2").is_err(), "another branch's checkout");
        let _ = std::fs::remove_dir_all(&wt);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn the_born_branches_are_read_before_the_checkout_goes_and_a_missing_one_is_an_error() {
        // Each birth at its own committer date: provenance pairs a branch's
        // birth with the checkout's reflog by time, and two births in one
        // second are not told apart.
        let repo = init_repo("door-born");
        let branch = "kd/door-born/1".to_string();
        let wt = repo.with_file_name(format!("{}-wt", repo.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&wt);
        git_at(&repo, 1_700_000_000, &["worktree", "add", "-q", "-b", &branch, wt.to_str().unwrap()]);
        git_at(&wt, 1_700_000_100, &["switch", "-q", "-c", "kd/born-side"]);
        let locks = RepoLocks::default();
        let mut born = born_branches(&locks, &repo, &wt).expect("read");
        born.sort();
        assert_eq!(born, ["kd/born-side".to_string(), branch]);

        let nowhere = repo.with_file_name("keepdeck-door-born-nowhere");
        assert!(born_branches(&locks, &repo, &nowhere).is_err(), "not a checkout");
        let _ = std::fs::remove_dir_all(&wt);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_planned_checkout_goes_with_its_uncommitted_work_and_a_gone_one_is_done() {
        let (repo, wt, _branch) = repo_with_worktree("door-checkout");
        std::fs::write(wt.join("wip.txt"), "uncommitted").unwrap();
        let locks = RepoLocks::default();
        remove_planned_checkout(&locks, &repo, &wt).expect("removed under consent");
        assert!(!wt.exists());
        assert!(is_registered_worktree(&repo, &wt) == Some(false));
        remove_planned_checkout(&locks, &repo, &wt).expect("a repeat finds it gone");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_planned_branch_goes_unmerged_but_one_checked_out_elsewhere_is_kept() {
        let (repo, wt, branch) = repo_with_worktree("door-branch");
        std::fs::write(wt.join("feature.txt"), "work").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-q", "-m", "unmerged"]);
        let locks = RepoLocks::default();

        // Still checked out: somebody's, kept — and that is not a failure.
        remove_planned_branch(&locks, &repo, &branch).expect("kept");
        assert!(branch_listed(&repo, &branch));

        remove_planned_checkout(&locks, &repo, &wt).expect("checkout gone");
        remove_planned_branch(&locks, &repo, &branch).expect("deleted, unmerged commits and all");
        assert!(!branch_listed(&repo, &branch));
        remove_planned_branch(&locks, &repo, &branch).expect("a repeat finds it gone");
        let _ = std::fs::remove_dir_all(&repo);
    }
}
