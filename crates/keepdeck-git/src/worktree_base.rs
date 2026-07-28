//! Git-native base metadata scoped to one worktree.
//!
//! Refs under `refs/worktree/` live in the current worktree's private gitdir,
//! rather than the repository's shared ref store. Git therefore keeps metadata
//! for sibling worktrees isolated and removes it with the worktree's
//! administrative record.

use std::path::Path;

use crate::cmd::run_git;
use crate::error::GitError;
use crate::repo;

/// Symbolic private ref that follows the local branch chosen as the base.
pub const BASE_REF: &str = "refs/worktree/keepdeck/base";

/// Direct private ref pinned to the exact base commit at creation time.
pub const BASE_AT_CREATION_REF: &str = "refs/worktree/keepdeck/base-at-creation";

const CREATED_REFLOG_MESSAGE: &str = "keepdeck: record worktree base at creation";
const BASE_REFLOG_MESSAGE: &str = "keepdeck: record worktree base branch";

/// Base metadata read from one worktree's private ref namespace.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BaseMetadata {
    /// Full local branch ref followed by [`BASE_REF`], when one was selected.
    pub branch_ref: Option<String>,
    /// Exact commit from which the worktree was created.
    pub at_creation: Option<String>,
}

/// Record the base of a newly-created worktree in its private ref namespace.
///
/// `base_commit` must be a full commit SHA already resolved by the caller.
/// `base_branch_ref`, when present, must be a full local ref under
/// `refs/heads/`. The direct ref gets its own reflog, whose entry records when
/// KeepDeck created the marker without requiring a separate application file.
pub fn record(
    worktree: &Path,
    base_commit: &str,
    base_branch_ref: Option<&str>,
) -> Result<(), GitError> {
    let missing_oid = "0".repeat(base_commit.len());
    run_git(
        worktree,
        [
            "update-ref",
            "--create-reflog",
            "-m",
            CREATED_REFLOG_MESSAGE,
            BASE_AT_CREATION_REF,
            base_commit,
            &missing_oid,
        ],
    )?;

    if let Some(base_branch_ref) = base_branch_ref {
        debug_assert!(base_branch_ref.starts_with("refs/heads/"));
        run_git(
            worktree,
            [
                "symbolic-ref",
                "-m",
                BASE_REFLOG_MESSAGE,
                BASE_REF,
                base_branch_ref,
            ],
        )?;
    }

    Ok(())
}

/// Read the base metadata private to `worktree`.
pub fn read(worktree: &Path) -> Result<BaseMetadata, GitError> {
    Ok(BaseMetadata {
        branch_ref: read_symbolic(worktree, BASE_REF)?,
        at_creation: read_commit(worktree, BASE_AT_CREATION_REF)?,
    })
}

/// Resolve the best fork point described by a worktree's private metadata.
///
/// The symbolic base is preferred so a rebase onto a newer tip of the same
/// branch is reflected dynamically. If that branch no longer resolves, the
/// pinned creation commit remains usable while it is still an ancestor of
/// `rev`. `None` means the caller should use its legacy/default-branch
/// heuristic.
pub fn fork_point(worktree: &Path, rev: &str) -> Result<Option<String>, GitError> {
    let metadata = read(worktree)?;

    if metadata.branch_ref.is_some() {
        if let Some(fork) = repo::merge_base(worktree, BASE_REF, rev)? {
            return Ok(Some(fork));
        }
    }

    let Some(created) = metadata.at_creation else {
        return Ok(None);
    };
    let remains_ancestor =
        repo::merge_base(worktree, &created, rev)?.as_deref() == Some(created.as_str());
    Ok(remains_ancestor.then_some(created))
}

fn read_symbolic(worktree: &Path, reference: &str) -> Result<Option<String>, GitError> {
    match run_git(worktree, ["symbolic-ref", "--quiet", reference]) {
        Ok(out) => Ok(non_empty(out)),
        Err(GitError::Command { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

fn read_commit(worktree: &Path, reference: &str) -> Result<Option<String>, GitError> {
    let spec = format!("{reference}^{{commit}}");
    match run_git(
        worktree,
        [
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &spec,
        ],
    ) {
        Ok(out) => Ok(non_empty(out)),
        Err(GitError::Command { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

fn non_empty(out: String) -> Option<String> {
    let value = out.trim();
    (!value.is_empty()).then(|| value.to_string())
}
