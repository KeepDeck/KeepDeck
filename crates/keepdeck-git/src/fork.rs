//! Where a branch's own work begins — the fork point a history view draws
//! its boundary at and counts "ahead" from.
//!
//! The ladder, top rung first:
//! 1. an EXPLICIT base wins — the merge-base against it, as asked;
//! 2. metadata a KeepDeck-managed worktree recorded at creation
//!    ([`worktree_base`]) follows the base it was cut from;
//! 3. a worktree without metadata combines validated creation evidence
//!    (the branch's reflog) with the default branch's merge-base.
//!
//! A fork AT the tip means "this ref IS the base": nothing to measure.

use std::path::Path;

use crate::error::GitError;
use crate::{provenance, repo, worktree, worktree_base};

/// The fork point of `rev` (already resolved to `tip`): `None` when there is
/// no meaningful one — the ref sits on its base, no base resolves, or the
/// two share no history.
pub fn fork_point(
    repo_path: &Path,
    rev: &str,
    tip: &str,
    base: Option<&str>,
) -> Result<Option<String>, GitError> {
    if let Some(base_ref) = base {
        // Named by the caller: a base that does not resolve is an error,
        // not "no fork" — the rest of the ladder tolerates dangling
        // revisions because it found them itself.
        return Ok(repo::merge_base_of_named(repo_path, base_ref, rev)?.filter(|fork| fork != tip));
    }
    match managed_worktree_fork(repo_path, rev, tip)? {
        WorktreeFork::Resolved(fork) => Ok(fork),
        WorktreeFork::Unavailable => legacy_fork(repo_path, rev, tip),
    }
}

/// Result of consulting worktree-private metadata. `Resolved(None)` is
/// intentionally distinct from `Unavailable`: metadata can authoritatively say
/// that the inspected ref is sitting at its base tip, in which case the default
/// branch heuristic must not invent a fork below it.
enum WorktreeFork {
    Unavailable,
    Resolved(Option<String>),
}

fn managed_worktree_fork(
    repo_path: &Path,
    rev: &str,
    tip: &str,
) -> Result<WorktreeFork, GitError> {
    let Some(metadata) = metadata_for_revision(repo_path, rev)? else {
        return Ok(WorktreeFork::Unavailable);
    };

    match metadata.fork_point(repo_path, rev)? {
        Some(fork) if fork == tip => Ok(WorktreeFork::Resolved(None)),
        Some(fork) => Ok(WorktreeFork::Resolved(Some(fork))),
        None => Ok(WorktreeFork::Unavailable),
    }
}

/// The base metadata that governs `rev`: the one recorded by the worktree
/// that was provisioned with `rev`'s branch.
///
/// The common case is answered first and cheaply: the revision is this
/// worktree's own `HEAD`, and this worktree recorded which branch it was
/// provisioned with — three ref reads away. Scanning every registered
/// worktree instead cost three reads PER worktree plus a reflog walk per
/// candidate without a match, on every history read; on a monorepo with ten
/// worktrees that was most of the eighty-odd processes one read spawned. The
/// scan stays for what it is for: browsing another branch by name, and
/// worktrees that recorded no branch of their own.
fn metadata_for_revision(
    repo_path: &Path,
    rev: &str,
) -> Result<Option<worktree_base::BaseMetadata>, GitError> {
    let Some(branch_ref) = revision_branch_ref(repo_path, rev)? else {
        return Ok(None);
    };
    let branch = branch_ref
        .strip_prefix("refs/heads/")
        .unwrap_or(&branch_ref);

    if rev == "HEAD" {
        let own = worktree_base::read(repo_path)?;
        if own.managed_branch_ref.as_deref() == Some(branch_ref.as_str()) {
            return Ok(Some(own));
        }
    }

    let mut candidates = Vec::new();
    for registered in worktree::list(repo_path)? {
        let metadata = worktree_base::read_registered(repo_path, &registered.path)?;
        if !metadata.is_empty() {
            candidates.push((registered.path, metadata));
        }
    }

    if let Some((_, metadata)) = candidates
        .iter()
        .find(|(_, metadata)| metadata.managed_branch_ref.as_deref() == Some(branch_ref.as_str()))
    {
        return Ok(Some(metadata.clone()));
    }

    for (worktree_path, metadata) in candidates {
        let created = provenance::created_branches(repo_path, &worktree_path)?;
        if created.iter().any(|created| created == branch) {
            return Ok(Some(metadata));
        }
    }
    Ok(None)
}

fn revision_branch_ref(repo_path: &Path, rev: &str) -> Result<Option<String>, GitError> {
    if rev == "HEAD" {
        return Ok(repo::current_branch(repo_path)?.map(|branch| format!("refs/heads/{branch}")));
    }
    repo::local_branch_ref(repo_path, rev)
}

/// The fork of a worktree without base metadata: the default branch's
/// merge-base, unless the branch's own creation record sits ABOVE it — a
/// picked base — in which case the creation record is the closer truth.
fn legacy_fork(repo_path: &Path, rev: &str, tip: &str) -> Result<Option<String>, GitError> {
    let Some(default_branch) = repo::default_branch(repo_path)? else {
        return Ok(None);
    };
    let Some(default_fork) = repo::merge_base(repo_path, &default_branch, rev)? else {
        return Ok(None);
    };

    let branch = revision_branch_ref(repo_path, rev)?
        .and_then(|reference| reference.strip_prefix("refs/heads/").map(str::to_string));
    let creation = match branch.as_deref() {
        Some(branch) if branch != default_branch => repo::branch_created_at(repo_path, branch)?,
        _ => None,
    };
    let valid_creation = match creation {
        Some(created)
            if created != tip
                && repo::merge_base(repo_path, &created, tip)?.as_deref()
                    == Some(created.as_str()) =>
        {
            Some(created)
        }
        _ => None,
    };

    let fork = match valid_creation {
        Some(created)
            if repo::merge_base(repo_path, &default_fork, &created)?.as_deref()
                == Some(default_fork.as_str()) =>
        {
            created
        }
        _ => default_fork,
    };
    Ok((fork != tip).then_some(fork))
}
