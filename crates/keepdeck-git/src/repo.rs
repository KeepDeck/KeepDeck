use std::path::Path;

use crate::cmd::{run_git, run_git_provisioning};
use crate::error::GitError;

/// Whether `path` is inside a git work tree.
///
/// Returns `false` (never errors) for a non-repo path, a missing path, or when
/// `git` can't be run — callers only care whether worktree isolation is
/// available here, so the ambiguity collapses to a plain "no".
pub fn is_git_repo(path: &Path) -> bool {
    run_git(path, ["rev-parse", "--is-inside-work-tree"])
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
    let Ok(out) = run_git(path, ["rev-parse", "--show-toplevel"]) else {
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
        ["rev-parse", "--verify", "--quiet", "--end-of-options", &spec],
    )?;
    Ok(out.trim().to_string())
}

/// Resolve `rev` to its full local branch ref, when it names one directly.
///
/// A commit SHA, tag, remote-tracking branch, detached `HEAD`, derived
/// expression (`main~1`), or missing revision returns `None`. This preserves
/// the identity of a selected local base branch separately from the exact
/// commit SHA pinned at worktree creation time.
pub fn local_branch_ref(repo: &Path, rev: &str) -> Result<Option<String>, GitError> {
    match run_git(
        repo,
        [
            "rev-parse",
            "--symbolic-full-name",
            "--verify",
            "--quiet",
            "--end-of-options",
            rev,
        ],
    ) {
        Ok(out) => {
            let reference = out.trim();
            Ok(reference
                .starts_with("refs/heads/")
                .then(|| reference.to_string()))
        }
        Err(GitError::Command { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// The repository's default branch — the remote HEAD's short name (`origin/HEAD`
/// → `main`), which is what "the default branch" means for a clone. `None` when
/// no `origin` remote declares one (no remote, unfetched HEAD, or a remote under
/// another name) — callers fall back to the current branch.
pub fn default_branch(repo: &Path) -> Result<Option<String>, GitError> {
    match run_git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        Ok(out) => Ok(out.trim().strip_prefix("origin/").map(str::to_string)),
        // Non-zero = the symbolic ref isn't set; that's an answer, not an error.
        Err(GitError::Command { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// The best common ancestor of two revisions — the fork point a branch's
/// history is measured from. `None` when the revisions share no history OR
/// either doesn't resolve: for the fork ladder that's an answer ("no fork
/// point"), not an error — the revisions it tries come from reflogs and
/// remote HEADs that a pruned reflog or a missing local branch can leave
/// dangling, and a history that failed outright for that would be worse
/// than one measured from the next rung. A revision the CALLER named is
/// [`merge_base_of_named`]'s business.
pub fn merge_base(repo: &Path, a: &str, b: &str) -> Result<Option<String>, GitError> {
    match run_git(repo, ["merge-base", "--", a, b]) {
        Ok(out) => Ok(Some(out.trim().to_string())),
        // Exit 1 = no common ancestor; unresolvable revs also land here.
        Err(GitError::Command { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// [`merge_base`] for revisions the caller NAMED — an explicit base typed
/// or picked by a person. "No common ancestor" (exit 1) is still an answer;
/// a revision that does not resolve is the caller's mistake, and answering
/// "no fork point" to it would hide the typo behind a plausible history.
pub fn merge_base_of_named(repo: &Path, a: &str, b: &str) -> Result<Option<String>, GitError> {
    match run_git(repo, ["merge-base", "--", a, b]) {
        Ok(out) => Ok(Some(out.trim().to_string())),
        Err(GitError::Command {
            status: Some(1), ..
        }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// Oldest commit in a local branch's reflog, when that reflog still begins
/// with the branch creation entry.
///
/// This is legacy migration evidence, not a fork authority by itself. Callers
/// must validate ancestry and compare it with the current default-branch
/// merge-base so a descendant rebase can supersede the stale creation point.
pub fn branch_created_at(repo: &Path, branch: &str) -> Result<Option<String>, GitError> {
    match run_git(
        repo,
        [
            "--no-optional-locks",
            "log",
            "-g",
            "--format=%H%x09%gs",
            branch,
            "--",
        ],
    ) {
        Ok(out) => Ok(out
            .lines()
            .rfind(|line| !line.is_empty())
            .and_then(|line| line.split_once('\t'))
            .filter(|(_, message)| message.starts_with("branch: Created from "))
            .map(|(sha, _)| sha.to_string())),
        Err(GitError::Command { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// The current branch name, or `None` when `HEAD` is detached.
///
/// Read as the symbolic ref, not through `rev-parse --abbrev-ref`: that
/// resolves the ref to a commit on the way, and an UNBORN branch — a fresh
/// `git init`, nothing committed yet — has none, so it failed outright where
/// the branch plainly has a name. `symbolic-ref -q` prints the name whether
/// or not a commit sits behind it, and exits 1, silently, when HEAD is
/// detached.
pub fn current_branch(repo: &Path) -> Result<Option<String>, GitError> {
    match run_git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]) {
        Ok(out) => Ok(Some(out.trim().to_string())),
        Err(GitError::Command {
            status: Some(1), ..
        }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// The commit `HEAD` points at, or `None` on an unborn branch — a repository
/// with no commit yet, where there is nothing to walk, diff or fork from.
/// Distinct from [`resolve_commit`], for which an unresolvable revision is
/// an error: a caller asking for HEAD's history wants "no commits yet" as an
/// answer, not a failure.
pub fn head_commit(repo: &Path) -> Result<Option<String>, GitError> {
    match run_git(
        repo,
        ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    ) {
        Ok(out) => Ok(Some(out.trim().to_string())),
        // `--quiet --verify` exits 1, silently, when the revision does not
        // resolve — for HEAD, that is the unborn branch.
        Err(GitError::Command {
            status: Some(1), ..
        }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// How many local branches a listing carries at most. A picker cannot show
/// thousands, and a repository with thousands (a long-lived monorepo, a
/// mirror with every contributor's branch) would otherwise hand the webview
/// an unbounded payload on every read — the same class of cost the diff
/// and log caps guard against.
pub const BRANCHES_MAX: usize = 1000;

/// The repository's local branch names, in git's default alphabetical
/// (refname) order, at most [`BRANCHES_MAX`] of them.
///
/// Local heads only — remote-tracking refs are deliberately excluded: this
/// feeds the "+ Agent" dialog's base-branch picker, and basing a worktree on a
/// possibly-stale `origin/*` ref is rejected by design (create a local branch
/// to use it). Detached HEAD contributes nothing (it isn't a ref under
/// `refs/heads`), so the list can be empty in a repo with no branches yet.
pub fn list_branches(repo: &Path) -> Result<Vec<String>, GitError> {
    list_branches_up_to(repo, BRANCHES_MAX)
}

/// [`list_branches`] with the cap as a parameter — the cap's own tests need
/// not create a thousand branches.
pub fn list_branches_up_to(repo: &Path, cap: usize) -> Result<Vec<String>, GitError> {
    let count = format!("--count={cap}");
    let out = run_git(
        repo,
        [
            "for-each-ref",
            "refs/heads",
            "--format=%(refname:short)",
            count.as_str(),
        ],
    )?;
    Ok(out
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

/// Whether `path` (relative to the repo) is ignored by the repository's
/// exclude rules — `.gitignore` at every level, `info/exclude`, the global
/// excludes — the way status and `ls-files --others` read them. A TRACKED
/// path is never ignored, whatever a pattern says: `check-ignore` leaves
/// tracked paths out unless asked otherwise. Exit 1 is "not ignored".
pub fn is_ignored(repo: &Path, path: &str) -> Result<bool, GitError> {
    match run_git(
        repo,
        ["--no-optional-locks", "check-ignore", "-q", "--", path],
    ) {
        Ok(_) => Ok(true),
        Err(GitError::Command {
            status: Some(1), ..
        }) => Ok(false),
        Err(other) => Err(other),
    }
}

/// Whether any tracked file sits at or under `path` (relative to the repo).
/// An ignored DIRECTORY can still hold files that were added by force; a
/// watcher that skips the directory for being ignored must not skip those.
pub fn has_tracked_files(repo: &Path, path: &str) -> Result<bool, GitError> {
    let out = run_git(repo, ["--no-optional-locks", "ls-files", "-z", "--", path])?;
    Ok(!out.is_empty())
}

/// Whether a local branch named `name` already exists in `repo`.
pub fn branch_exists(repo: &Path, name: &str) -> Result<bool, GitError> {
    let reference = format!("refs/heads/{name}");
    match run_git(repo, ["show-ref", "--verify", "--quiet", &reference]) {
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
    // Provisioning, not a read: on no clock, like the worktree commands.
    run_git_provisioning(repo, ["branch", flag, "--", name]).map(drop)
}
