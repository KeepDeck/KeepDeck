//! Git-native base metadata scoped to one worktree.
//!
//! Refs under `refs/worktree/` live in the current worktree's private gitdir,
//! rather than the repository's shared ref store. Git therefore keeps metadata
//! for sibling worktrees isolated and removes it with the worktree's
//! administrative record.

use std::path::Path;

use crate::cmd::run_git;
use crate::error::GitError;
use crate::head;
use crate::repo;
use crate::worktree;

/// Symbolic private ref that follows the local branch chosen as the base.
pub const BASE_REF: &str = "refs/worktree/keepdeck/base";

/// Direct private ref pinned to the exact base commit at creation time.
pub const BASE_AT_CREATION_REF: &str = "refs/worktree/keepdeck/base-at-creation";

/// Symbolic private ref naming the branch provisioned with this worktree.
pub const MANAGED_BRANCH_REF: &str = "refs/worktree/keepdeck/branch";

const CREATED_REFLOG_MESSAGE: &str = "keepdeck: record worktree base at creation";
const BASE_REFLOG_MESSAGE: &str = "keepdeck: record worktree base branch";
const MANAGED_BRANCH_REFLOG_MESSAGE: &str = "keepdeck: record managed worktree branch";

/// Base metadata read from one worktree's private ref namespace.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BaseMetadata {
    /// Full local branch ref followed by [`BASE_REF`], when one was selected.
    pub branch_ref: Option<String>,
    /// Exact commit from which the worktree was created.
    pub at_creation: Option<String>,
    /// Full ref of the branch KeepDeck provisioned with this worktree.
    pub managed_branch_ref: Option<String>,
}

impl BaseMetadata {
    /// Whether this worktree has no KeepDeck base metadata.
    pub fn is_empty(&self) -> bool {
        self.branch_ref.is_none()
            && self.at_creation.is_none()
            && self.managed_branch_ref.is_none()
    }

    /// Resolve the best fork point described by this metadata.
    pub fn fork_point(&self, repo_path: &Path, rev: &str) -> Result<Option<String>, GitError> {
        let creation = match self.at_creation.as_ref() {
            Some(created)
                if repo::merge_base(repo_path, created, rev)?.as_deref()
                    == Some(created.as_str()) =>
            {
                Some(created)
            }
            _ => None,
        };
        let dynamic = match self.branch_ref.as_deref() {
            Some(base_ref) => repo::merge_base(repo_path, base_ref, rev)?,
            None => None,
        };

        match (dynamic, creation) {
            // A reset/recreation of the named base must not move the fork
            // behind commits already present when the worktree was created.
            (Some(dynamic), Some(created))
                if repo::merge_base(repo_path, &dynamic, created)?.as_deref()
                    == Some(dynamic.as_str()) =>
            {
                Ok(Some(created.clone()))
            }
            (Some(dynamic), _) => Ok(Some(dynamic)),
            (None, Some(created)) => Ok(Some(created.clone())),
            (None, None) => Ok(None),
        }
    }
}

/// Record the base of a newly-created worktree in its private ref namespace.
///
/// `base_commit` must be a full commit SHA already resolved by the caller.
/// `base_branch_ref`, when present, must be a full local ref under
/// `refs/heads/`. `managed_branch_ref` must name the full local branch ref
/// provisioned with the worktree. All inputs are validated before any ref is
/// written. The direct ref gets its own reflog, whose entry records when
/// KeepDeck created the marker without requiring a separate application file.
pub fn record(
    worktree: &Path,
    base_commit: &str,
    base_branch_ref: Option<&str>,
    managed_branch_ref: &str,
) -> Result<(), GitError> {
    if !head::is_commit_sha(base_commit) {
        return Err(GitError::InvalidInput(format!(
            "base commit must be a full SHA-1 or SHA-256 object id, got {base_commit:?}"
        )));
    }
    if let Some(base_branch_ref) = base_branch_ref {
        validate_local_branch_ref(worktree, base_branch_ref, "base branch")?;
    }
    validate_local_branch_ref(worktree, managed_branch_ref, "managed branch")?;

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

    run_git(
        worktree,
        [
            "symbolic-ref",
            "-m",
            MANAGED_BRANCH_REFLOG_MESSAGE,
            MANAGED_BRANCH_REF,
            managed_branch_ref,
        ],
    )?;

    Ok(())
}

/// Read the base metadata private to `worktree`.
pub fn read(worktree: &Path) -> Result<BaseMetadata, GitError> {
    read_refs(
        worktree,
        BASE_REF,
        BASE_AT_CREATION_REF,
        MANAGED_BRANCH_REF,
    )
}

/// Read one registered worktree's private metadata through its live directory
/// or, if that directory disappeared, through Git's surviving admin namespace.
pub fn read_registered(
    repo_path: &Path,
    registered_worktree: &Path,
) -> Result<BaseMetadata, GitError> {
    if registered_worktree.exists() {
        match read(registered_worktree) {
            Ok(metadata) => return Ok(metadata),
            // The directory may have disappeared between `exists` and git.
            Err(GitError::Command { .. }) => {}
            Err(other) => return Err(other),
        }
    }

    let Some(admin) = worktree::admin_git_dir(repo_path, registered_worktree)? else {
        return Ok(BaseMetadata::default());
    };
    let Some(id) = admin.file_name().map(|name| name.to_string_lossy()) else {
        return Ok(BaseMetadata::default());
    };
    let private_ref = |reference: &str| format!("worktrees/{id}/{reference}");
    read_refs(
        repo_path,
        &private_ref(BASE_REF),
        &private_ref(BASE_AT_CREATION_REF),
        &private_ref(MANAGED_BRANCH_REF),
    )
}

fn read_refs(
    repo_path: &Path,
    base_ref: &str,
    creation_ref: &str,
    managed_branch_ref: &str,
) -> Result<BaseMetadata, GitError> {
    Ok(BaseMetadata {
        branch_ref: read_symbolic(repo_path, base_ref)?,
        at_creation: read_commit(repo_path, creation_ref)?,
        managed_branch_ref: read_symbolic(repo_path, managed_branch_ref)?,
    })
}

fn validate_local_branch_ref(
    worktree: &Path,
    reference: &str,
    label: &str,
) -> Result<(), GitError> {
    if !reference.starts_with("refs/heads/") {
        return Err(GitError::InvalidInput(format!(
            "{label} must be under refs/heads/, got {reference:?}"
        )));
    }
    run_git(worktree, ["check-ref-format", reference]).map(drop)
}

fn read_symbolic(worktree: &Path, reference: &str) -> Result<Option<String>, GitError> {
    match run_git(worktree, ["symbolic-ref", "--quiet", reference]) {
        Ok(out) => Ok(non_empty(out)),
        Err(GitError::Command {
            status: Some(1), ..
        }) => Ok(None),
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
        Err(GitError::Command {
            status: Some(1), ..
        }) => Ok(None),
        Err(other) => Err(other),
    }
}

fn non_empty(out: String) -> Option<String> {
    let value = out.trim();
    (!value.is_empty()).then(|| value.to_string())
}
