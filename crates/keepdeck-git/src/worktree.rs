use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::cmd::{run_git, run_git_capped_bytes, run_git_provisioning};
use crate::error::GitError;
use crate::head;

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
    /// Whether git calls it prunable: its directory is gone, and only the
    /// administrative record is left.
    pub prunable: bool,
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
                    prunable: false,
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
            // With or without a reason after it — either way the record
            // outlived its directory.
            "prunable" => {
                if let Some(w) = cur.as_mut() {
                    w.prunable = true;
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
    // `--no-track`: when `base_commit` names a remote-tracking branch (a
    // user-typed `origin/main`), `-b` would otherwise set it as the new
    // branch's upstream — wrong for a local working branch, whose status/pull
    // must never compare against a remote base. A plain commit-ish base gets
    // no upstream either way, so this only guards the remote-base case.
    // `--` ends option parsing (the dir is user-editable, so a leaf starting
    // with `-` must not be read by git as a flag); the path passes as an OsStr
    // so a non-UTF-8 path isn't corrupted.
    // No clock: the checkout runs smudge filters and the post-checkout hook,
    // and a large tree takes as long as it takes (see `run_git_provisioning`).
    run_git_provisioning(
        repo,
        [
            OsStr::new("worktree"),
            OsStr::new("add"),
            OsStr::new("--no-track"),
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
    let out = run_git(repo, ["worktree", "list", "--porcelain"])?;
    Ok(parse_worktrees(&out))
}

/// How much of a NUL-separated listing [`roots`] reads: far past any real
/// repo's worktrees. A longer answer is an error, never a partial list.
const ROOTS_LISTING_MAX_BYTES: usize = 1024 * 1024;

/// Every root holding a working tree of the repository whose COMMON git dir
/// is `common_dir`: the main one (none for a bare repo) and each linked one
/// still there — a prunable entry's directory is gone. Read losslessly
/// (`--porcelain -z`), so a path with any byte in it is exactly that path. An
/// answer that cannot be read whole is an error: a caller deciding that no
/// worktree needs something must not decide on part of the list.
pub fn roots(common_dir: &Path) -> Result<Vec<PathBuf>, GitError> {
    let out = run_git_capped_bytes(common_dir, ["worktree", "list", "--porcelain", "-z"], ROOTS_LISTING_MAX_BYTES)?;
    if out.truncated {
        return Err(GitError::InvalidInput("the worktree listing is longer than any repo's".into()));
    }
    Ok(parse_roots(&out.bytes))
}

/// The roots in a `worktree list --porcelain -z` answer: blocks of
/// NUL-terminated attributes, an empty one between blocks.
fn parse_roots(bytes: &[u8]) -> Vec<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let mut roots = Vec::new();
    let mut block: Vec<&[u8]> = Vec::new();
    let mut close = |block: &mut Vec<&[u8]>| {
        let root = block.iter().find_map(|attr| attr.strip_prefix(b"worktree "));
        let gone = block.iter().any(|attr| *attr == b"bare" || attr.starts_with(b"prunable"));
        if let (Some(root), false) = (root, gone) {
            roots.push(PathBuf::from(OsStr::from_bytes(root)));
        }
        block.clear();
    };
    for attr in bytes.split(|b| *b == 0) {
        if attr.is_empty() {
            close(&mut block);
        } else {
            block.push(attr);
        }
    }
    close(&mut block);
    roots
}

/// Is `path` one of `repo`'s registered worktrees?
///
/// Compared the way git's own records are: a listing reports realpaths, while a
/// caller's path may spell the same directory differently, so [`paths_match`]
/// decides — the one comparison, rather than a second one written at the call
/// site. `Err` is left to the caller: "we could not ask git" is not the same
/// answer as "no", and a caller acting on the difference must be able to tell.
pub fn is_registered(repo: &Path, path: &Path) -> Result<bool, GitError> {
    Ok(list(repo)?
        .iter()
        .any(|known| paths_match(&known.path, path)))
}

/// Locate the surviving administrative gitdir for a registered linked
/// worktree, even when its working directory has been deleted externally.
pub(crate) fn admin_git_dir(
    repo_path: &Path,
    worktree_path: &Path,
) -> Result<Option<PathBuf>, GitError> {
    let worktrees = head::git_common_dir(repo_path)?.join("worktrees");
    let Ok(entries) = std::fs::read_dir(&worktrees) else {
        return Ok(None);
    };
    for entry in entries.flatten() {
        let admin = entry.path();
        let Ok(pointer) = std::fs::read_to_string(admin.join("gitdir")) else {
            continue;
        };
        let matches = PathBuf::from(pointer.trim())
            .parent()
            .is_some_and(|recorded| paths_match(recorded, worktree_path));
        if matches {
            return Ok(Some(admin));
        }
    }
    Ok(None)
}

/// Compare a worktree path with Git's realpath-based administrative pointer.
pub fn paths_match(recorded: &Path, worktree: &Path) -> bool {
    if recorded == worktree {
        return true;
    }
    let canonical_leaf = |path: &Path| -> Option<PathBuf> {
        Some(
            path.parent()?
                .canonicalize()
                .ok()?
                .join(path.file_name()?),
        )
    };
    match (canonical_leaf(recorded), canonical_leaf(worktree)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
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
    run_git_provisioning(repo, args).map(drop)
}

/// Prune administrative records of worktrees whose directories are gone.
pub fn prune(repo: &Path) -> Result<(), GitError> {
    run_git_provisioning(repo, ["worktree", "prune"]).map(drop)
}

/// Whether the working tree at `path` has uncommitted or untracked changes.
pub fn is_dirty(path: &Path) -> Result<bool, GitError> {
    let out = run_git(path, ["status", "--porcelain"])?;
    Ok(!out.trim().is_empty())
}

/// How many entries `git status` reports as changed in the worktree at
/// `path`: modified, staged, deleted and untracked ones (an untracked
/// directory counts once). Ignored files are not counted — and are lost
/// with the folder all the same.
pub fn changed_entries(path: &Path) -> Result<usize, GitError> {
    let out = run_git(path, ["status", "--porcelain", "--untracked-files=normal"])?;
    Ok(out.lines().filter(|line| !line.trim().is_empty()).count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nul_separated_listing_names_each_live_root_byte_for_byte() {
        let listing = b"worktree /repo\0HEAD 1111\0branch refs/heads/main\0\0\
worktree /odd\nname\0HEAD 2222\0detached\0\0\
worktree /gone\0HEAD 3333\0prunable gitdir file points to non-existent location\0\0\
worktree /bare.git\0bare\0\0";
        assert_eq!(parse_roots(listing), vec![PathBuf::from("/repo"), PathBuf::from("/odd\nname")]);
    }

    #[test]
    fn parses_prunable_with_and_without_a_reason() {
        let porcelain = "\
worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /gone/a
HEAD 2222222222222222222222222222222222222222
branch refs/heads/kd/a
prunable gitdir file points to non-existent location

worktree /gone/b
HEAD 3333333333333333333333333333333333333333
detached
prunable
";
        let rows = parse_worktrees(porcelain);
        assert_eq!(rows.iter().map(|w| w.prunable).collect::<Vec<_>>(), vec![false, true, true]);
        assert!(rows[2].detached);
    }

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
