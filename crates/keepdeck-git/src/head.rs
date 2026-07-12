//! Reading a worktree's `HEAD` straight from disk.
//!
//! The pane-header branch badge must track checkouts made INSIDE a worktree
//! (by the agent, or the user in a terminal) live. The signal is the worktree's
//! private `HEAD` file: every `git checkout`/`switch` rewrites it, so a file
//! watcher on its directory sees the change the moment it happens. This module
//! supplies the two halves the watcher needs: WHERE that file lives
//! ([`git_dir`]) and WHAT its content means ([`parse_head`]). Reading `HEAD` is
//! a plain file read, not a `git` invocation — the point is a per-event cost of
//! one 41-byte read instead of one subprocess.

use std::fs;
use std::path::{Path, PathBuf};

use crate::cmd::run_git;
use crate::error::GitError;

/// Where a worktree's `HEAD` points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Head {
    /// Checked out on a branch (short name, without `refs/heads/`).
    Branch(String),
    /// Detached at a commit (the full SHA as written in `HEAD`).
    Detached(String),
}

/// The worktree's private git directory, absolute: `<repo>/.git/worktrees/<n>`
/// for a linked worktree, `<repo>/.git` for a main one. This is the directory
/// whose `HEAD` changes on checkout — i.e. the thing to watch. Resolved by git
/// itself (one shell-out at watch-registration time), so exotic layouts
/// (`--separate-git-dir`, nested worktrees) resolve correctly too.
pub fn git_dir(worktree: &Path) -> Result<PathBuf, GitError> {
    let out = run_git(worktree, &["rev-parse", "--absolute-git-dir"])?;
    Ok(PathBuf::from(out.trim()))
}

/// The repository's COMMON gitdir — where the SHARED state lives: refs,
/// packed-refs, the object store. For the main checkout it is the gitdir
/// itself; for a linked worktree it is the main repository's `.git`, while
/// the worktree's private gitdir holds only its own HEAD/index. A watcher
/// that wants to see branches move must look here.
pub fn git_common_dir(worktree: &Path) -> Result<PathBuf, GitError> {
    let out = run_git(
        worktree,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    Ok(PathBuf::from(out.trim()))
}

/// Read and parse `<git_dir>/HEAD`. `None` when the file is missing, unreadable
/// or malformed — e.g. mid-checkout transient states — which callers treat as
/// "no update" rather than an error (the next event re-reads a settled file).
pub fn read_head(git_dir: &Path) -> Option<Head> {
    let content = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    parse_head(&content)
}

/// Parse the content of a `HEAD` file: `ref: refs/heads/<name>` means a branch
/// checkout, a bare commit SHA means detached. Pure; anything else — including
/// a symref outside `refs/heads/` (never written by checkout) — is `None`.
pub fn parse_head(content: &str) -> Option<Head> {
    let line = content.lines().next()?.trim();
    if let Some(reference) = line.strip_prefix("ref:") {
        let name = reference.trim().strip_prefix("refs/heads/")?;
        return (!name.is_empty()).then(|| Head::Branch(name.to_string()));
    }
    is_commit_sha(line).then(|| Head::Detached(line.to_string()))
}

/// A full object id: 40 hex chars (SHA-1) or 64 (SHA-256 repos).
fn is_commit_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_branch_ref() {
        assert_eq!(
            parse_head("ref: refs/heads/main\n"),
            Some(Head::Branch("main".into()))
        );
    }

    #[test]
    fn keeps_slashes_in_branch_names() {
        // KeepDeck's own branches are slashed (`kd/<ws>/<n>`) — only the
        // `refs/heads/` prefix comes off.
        assert_eq!(
            parse_head("ref: refs/heads/kd/KeepDeck/2\n"),
            Some(Head::Branch("kd/KeepDeck/2".into()))
        );
    }

    #[test]
    fn parses_a_detached_sha() {
        let sha = "a".repeat(40);
        assert_eq!(parse_head(&format!("{sha}\n")), Some(Head::Detached(sha)));
    }

    #[test]
    fn parses_a_sha256_detached_sha() {
        let sha = "0123456789abcdef".repeat(4);
        assert_eq!(parse_head(&format!("{sha}\n")), Some(Head::Detached(sha)));
    }

    #[test]
    fn rejects_non_branch_refs_and_garbage() {
        assert_eq!(parse_head("ref: refs/tags/v1\n"), None);
        assert_eq!(parse_head("ref: refs/heads/\n"), None);
        assert_eq!(parse_head("not-a-sha\n"), None);
        assert_eq!(parse_head("abc123\n"), None); // hex, but not a full oid
        assert_eq!(parse_head(""), None);
    }

    #[test]
    fn reads_only_the_first_line() {
        assert_eq!(
            parse_head("ref: refs/heads/x\ntrailing junk"),
            Some(Head::Branch("x".into()))
        );
    }
}
