use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::cmd::run_git;
use crate::error::GitError;

/// A worktree as reported by `git worktree list --porcelain`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeInfo {
    /// Absolute path of the worktree's working directory.
    pub path: PathBuf,
    /// The checked-out commit SHA, if any.
    pub head: Option<String>,
    /// Short branch name (without `refs/heads/`), if on a branch.
    pub branch: Option<String>,
    /// Whether this entry is the repository's bare main worktree.
    pub bare: bool,
    /// Whether the worktree is in detached-HEAD state.
    pub detached: bool,
    /// Whether the worktree is locked.
    pub locked: bool,
}

/// Parse the output of `git worktree list --porcelain` into structured entries.
///
/// Pure: blocks are separated by blank lines, each a sequence of `key [value]`
/// lines (`worktree`, `HEAD`, `branch`, `bare`, `detached`, `locked`).
pub fn parse_worktrees(porcelain: &str) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;

    for line in porcelain.lines() {
        if line.is_empty() {
            out.extend(cur.take());
            continue;
        }
        let (key, value) = match line.split_once(' ') {
            Some((k, v)) => (k, Some(v)),
            None => (line, None),
        };
        match key {
            "worktree" => {
                out.extend(cur.take());
                cur = Some(WorktreeInfo {
                    path: PathBuf::from(value.unwrap_or_default()),
                    head: None,
                    branch: None,
                    bare: false,
                    detached: false,
                    locked: false,
                });
            }
            "HEAD" => {
                if let Some(w) = cur.as_mut() {
                    w.head = value.map(str::to_string);
                }
            }
            "branch" => {
                if let Some(w) = cur.as_mut() {
                    w.branch = value.map(short_branch);
                }
            }
            "bare" => {
                if let Some(w) = cur.as_mut() {
                    w.bare = true;
                }
            }
            "detached" => {
                if let Some(w) = cur.as_mut() {
                    w.detached = true;
                }
            }
            "locked" => {
                if let Some(w) = cur.as_mut() {
                    w.locked = true;
                }
            }
            _ => {}
        }
    }
    out.extend(cur.take());
    out
}

fn short_branch(reference: &str) -> String {
    reference
        .strip_prefix("refs/heads/")
        .unwrap_or(reference)
        .to_string()
}

/// Add a worktree at `path` on a new branch `branch`, checked out at
/// `base_commit`.
///
/// The parent of `path` must already exist and `path` itself must not. The
/// caller is responsible for serializing concurrent adds on one repo (git takes
/// `.git` locks that race) and for choosing a unique `branch`/`path`.
pub fn add(repo: &Path, path: &Path, branch: &str, base_commit: &str) -> Result<(), GitError> {
    // `--` ends option parsing (the dir is user-editable, so a leaf starting
    // with `-` must not be read by git as a flag); the path passes as an OsStr
    // so a non-UTF-8 path isn't corrupted.
    run_git(
        repo,
        [
            OsStr::new("worktree"),
            OsStr::new("add"),
            OsStr::new("-b"),
            OsStr::new(branch),
            OsStr::new("--"),
            path.as_os_str(),
            OsStr::new(base_commit),
        ],
    )
    .map(drop)
}

/// List the repository's worktrees.
pub fn list(repo: &Path) -> Result<Vec<WorktreeInfo>, GitError> {
    let out = run_git(repo, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktrees(&out))
}

/// Remove the worktree at `path`.
///
/// With `force`, removes it even if it has uncommitted or untracked changes —
/// callers must gate this: KeepDeck never force-removes a dirty worktree
/// without explicit intent (work would be lost).
pub fn remove(repo: &Path, path: &Path, force: bool) -> Result<(), GitError> {
    let mut args: Vec<&OsStr> = vec![OsStr::new("worktree"), OsStr::new("remove")];
    if force {
        args.push(OsStr::new("--force"));
    }
    args.push(OsStr::new("--")); // end of options — the path is positional (see `add`)
    args.push(path.as_os_str());
    run_git(repo, args).map(drop)
}

/// Prune administrative records of worktrees whose directories are gone.
pub fn prune(repo: &Path) -> Result<(), GitError> {
    run_git(repo, &["worktree", "prune"]).map(drop)
}

/// Whether the working tree at `path` has uncommitted or untracked changes.
pub fn is_dirty(path: &Path) -> Result<bool, GitError> {
    let out = run_git(path, &["status", "--porcelain"])?;
    Ok(!out.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiple_blocks() {
        let porcelain = "\
worktree /repo
HEAD abc123
branch refs/heads/main

worktree /tmp/wt/agent-1
HEAD def456
branch refs/heads/kd/ws/1

worktree /tmp/wt/detached
HEAD 999fff
detached
";
        let got = parse_worktrees(porcelain);
        assert_eq!(got.len(), 3);

        assert_eq!(got[0].path, PathBuf::from("/repo"));
        assert_eq!(got[0].branch.as_deref(), Some("main"));
        assert_eq!(got[0].head.as_deref(), Some("abc123"));
        assert!(!got[0].detached);

        assert_eq!(got[1].path, PathBuf::from("/tmp/wt/agent-1"));
        assert_eq!(got[1].branch.as_deref(), Some("kd/ws/1"));

        assert_eq!(got[2].branch, None);
        assert!(got[2].detached);
    }

    #[test]
    fn handles_a_trailing_block_without_a_blank_line() {
        let got = parse_worktrees("worktree /only\nHEAD a1\nbranch refs/heads/x");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].branch.as_deref(), Some("x"));
    }

    #[test]
    fn empty_input_yields_no_worktrees() {
        assert!(parse_worktrees("").is_empty());
    }
}
