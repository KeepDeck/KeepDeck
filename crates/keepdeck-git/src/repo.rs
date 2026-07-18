use std::path::Path;

use crate::cmd::run_git;
use crate::error::GitError;

/// Whether `path` is inside a git work tree.
///
/// Returns `false` (never errors) for a non-repo path, a missing path, or when
/// `git` can't be run — callers only care whether worktree isolation is
/// available here, so the ambiguity collapses to a plain "no".
pub fn is_git_repo(path: &Path) -> bool {
    run_git(path, &["rev-parse", "--is-inside-work-tree"])
        .map(|out| out.trim() == "true")
        .unwrap_or(false)
}

/// Whether `path` is the ROOT of a git work tree — the only shape an agent can
/// attach to as an existing worktree.
///
/// [`is_git_repo`] answers "somewhere inside a work tree", which is equally
/// true of every SUBDIRECTORY: classifying those as attachable would silently
/// drop an agent onto the main repo's branch with no isolation. So ask git for
/// the work tree's root and compare.
///
/// Both sides are canonicalized: `--show-toplevel` already resolves symlinks
/// (on macOS `/tmp` is really `/private/tmp`), so comparing it against a raw
/// user-entered path would report a false negative for the root itself.
///
/// Returns `false` (never errors) for a non-repo path, a missing path, a bare
/// repo, or when `git` can't be run — same collapse-to-"no" contract as
/// [`is_git_repo`].
pub fn is_worktree_root(path: &Path) -> bool {
    let Ok(out) = run_git(path, &["rev-parse", "--show-toplevel"]) else {
        return false;
    };
    match (Path::new(out.trim()).canonicalize(), path.canonicalize()) {
        (Ok(top), Ok(probed)) => top == probed,
        _ => false,
    }
}

/// Resolve a revision (`"HEAD"`, a branch, a tag, …) to a concrete commit SHA.
///
/// Used to pin the base of a batch of worktrees to one commit, so concurrently
/// spawned agents all start from the same state even if `HEAD` moves mid-batch.
pub fn resolve_commit(repo: &Path, rev: &str) -> Result<String, GitError> {
    let spec = format!("{rev}^{{commit}}");
    // `--end-of-options`: the rev can be user-typed (the dialog's degraded
    // free-text base), so a leading-dash spelling must reach rev-parse as a
    // revision, not an option — the same guard the `--` siblings carry.
    let out = run_git(
        repo,
        &["rev-parse", "--verify", "--quiet", "--end-of-options", &spec],
    )?;
    Ok(out.trim().to_string())
}

/// The repository's default branch — the remote HEAD's short name (`origin/HEAD`
/// → `main`), which is what "the default branch" means for a clone. `None` when
/// no `origin` remote declares one (no remote, unfetched HEAD, or a remote under
/// another name) — callers fall back to the current branch.
pub fn default_branch(repo: &Path) -> Result<Option<String>, GitError> {
    match run_git(repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        Ok(out) => Ok(out.trim().strip_prefix("origin/").map(str::to_string)),
        // Non-zero = the symbolic ref isn't set; that's an answer, not an error.
        Err(GitError::Command { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// The best common ancestor of two revisions — the fork point a branch's
/// history is measured from. `None` when the revisions share no history (or
/// either doesn't resolve): for a changes view that's an answer ("no fork
/// point"), not an error.
pub fn merge_base(repo: &Path, a: &str, b: &str) -> Result<Option<String>, GitError> {
    match run_git(repo, ["merge-base", "--", a, b]) {
        Ok(out) => Ok(Some(out.trim().to_string())),
        // Exit 1 = no common ancestor; unresolvable revs also land here.
        Err(GitError::Command { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// The commit a branch was CREATED at — its reflog's oldest entry. Git writes
/// that entry at `branch -b`/`worktree add -b` time (`branch: Created from …`),
/// so the true fork point is already persisted by git itself: nothing of ours
/// to store, and exact even when the branch was cut from a picked base the
/// default-branch heuristic would misjudge. `None` when the reflog is gone
/// (expired, disabled, foreign clone) — callers fall back to a heuristic.
///
/// Callers must validate the answer is still an ANCESTOR of the branch tip:
/// a rebase moves the branch off its creation point, orphaning the entry.
pub fn branch_created_at(repo: &Path, branch: &str) -> Result<Option<String>, GitError> {
    match run_git(
        repo,
        ["--no-optional-locks", "log", "-g", "--format=%H", branch, "--"],
    ) {
        Ok(out) => Ok(out
            .lines()
            .filter(|line| !line.is_empty())
            .next_back()
            .map(str::to_string)),
        // No reflog for the ref is an answer, not an error.
        Err(GitError::Command { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// The current branch name, or `None` when `HEAD` is detached.
pub fn current_branch(repo: &Path) -> Result<Option<String>, GitError> {
    let out = run_git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let name = out.trim();
    Ok(if name == "HEAD" {
        None
    } else {
        Some(name.to_string())
    })
}

/// The repository's local branch names, in git's default alphabetical
/// (refname) order.
///
/// Local heads only — remote-tracking refs are deliberately excluded: this
/// feeds the "+ Agent" dialog's base-branch picker, and basing a worktree on a
/// possibly-stale `origin/*` ref is rejected by design (create a local branch
/// to use it). Detached HEAD contributes nothing (it isn't a ref under
/// `refs/heads`), so the list can be empty in a repo with no branches yet.
pub fn list_branches(repo: &Path) -> Result<Vec<String>, GitError> {
    let out = run_git(
        repo,
        &["for-each-ref", "refs/heads", "--format=%(refname:short)"],
    )?;
    Ok(out
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

/// Whether a local branch named `name` already exists in `repo`.
pub fn branch_exists(repo: &Path, name: &str) -> Result<bool, GitError> {
    let reference = format!("refs/heads/{name}");
    match run_git(repo, &["show-ref", "--verify", "--quiet", &reference]) {
        Ok(_) => Ok(true),
        // `--quiet` exits non-zero (no output) when the ref is absent.
        Err(GitError::Command { .. }) => Ok(false),
        Err(other) => Err(other),
    }
}

/// Delete a local branch by name.
///
/// `force` maps to `git branch -D` (deletes even a branch with commits not
/// merged anywhere), while without it `git branch -d` refuses an unmerged
/// branch so work isn't dropped by accident. The branch must NOT be checked out
/// in any worktree — remove that worktree first, or git refuses the delete.
///
/// The name is expected pre-sanitized (KeepDeck branches never start with `-`);
/// the `--` end-of-options guard makes that belt-and-suspenders, matching the
/// `worktree add`/`remove` siblings so no positional name can be read as a flag.
pub fn delete_branch(repo: &Path, name: &str, force: bool) -> Result<(), GitError> {
    let flag = if force { "-D" } else { "-d" };
    run_git(repo, ["branch", flag, "--", name]).map(drop)
}
