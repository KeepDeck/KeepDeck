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

/// Resolve a revision (`"HEAD"`, a branch, a tag, …) to a concrete commit SHA.
///
/// Used to pin the base of a batch of worktrees to one commit, so concurrently
/// spawned agents all start from the same state even if `HEAD` moves mid-batch.
pub fn resolve_commit(repo: &Path, rev: &str) -> Result<String, GitError> {
    let spec = format!("{rev}^{{commit}}");
    let out = run_git(repo, &["rev-parse", "--verify", "--quiet", &spec])?;
    Ok(out.trim().to_string())
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
