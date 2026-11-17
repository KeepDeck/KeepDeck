//! Keeping git blind to what KeepDeck plants inside a pane's working
//! directory ([`crate::cwd_arm`]): an anchored line in the owning repo's
//! SHARED `info/exclude`, added when something is planted and removed when
//! nothing of ours needs it any more.

use std::io;
use std::path::{Path, PathBuf};

/// A path to keep git blind to, relative to the armed cwd, matched
/// literally: a name holding `*`, `?` or `[` is that name, not a pattern.
/// `directory` matches it only as a directory (a symlink is a file to git).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Excluded {
    pub(crate) path: String,
    pub(crate) directory: bool,
}

/// Idempotently append `excluded`'s anchored line to the owning repo's SHARED
/// `info/exclude`, so what was planted never shows up in git status or a
/// commit. A cwd outside any checkout simply has nowhere to write and is left
/// alone.
pub(crate) fn ensure_excluded(armed_root: &Path, excluded: &Excluded) -> io::Result<()> {
    match exclusion(armed_root, excluded)? {
        Some((common_dir, line)) => keepdeck_git::exclude::ensure_line(&common_dir, &line),
        None => Ok(()),
    }
}

/// Remove the line arming appended, only where it carries KeepDeck's marker —
/// the same pattern the user wrote stays, and nothing else in their exclude
/// file is touched (byte-faithful removal lives in `keepdeck_git::exclude`).
pub(crate) fn remove_excluded(armed_root: &Path, excluded: &Excluded) -> io::Result<()> {
    match exclusion(armed_root, excluded)? {
        Some((common_dir, line)) => keepdeck_git::exclude::remove_line(&common_dir, &line),
        None => Ok(()),
    }
}

/// The owning repo's COMMON git dir plus the line keeping git blind to
/// `excluded` — anchored at the armed cwd (`/<path>` at the repo root,
/// `/<subdir>/<path>` below it), literal throughout, with a trailing `/` for
/// a directory only — or `None` when no ancestor is a git checkout. Two linked
/// worktrees of one repo share the common dir, so two plantings with the same
/// exclusion share ONE line: it goes only with the last of them.
pub(crate) fn exclusion(armed_root: &Path, excluded: &Excluded) -> io::Result<Option<(PathBuf, String)>> {
    let Some(repo) = keepdeck_git::exclude::owning_repo(armed_root)? else {
        return Ok(None);
    };
    let common_dir = std::fs::canonicalize(&repo.common_dir).unwrap_or(repo.common_dir);
    let path = if repo.below_root.is_empty() {
        excluded.path.clone()
    } else {
        format!("{}/{}", repo.below_root, excluded.path)
    };
    let suffix = if excluded.directory { "/" } else { "" };
    Ok(Some((common_dir, format!("/{}{suffix}", literal(&path)))))
}

/// `path` as a gitignore pattern matching only itself: git's wildcard and
/// escape characters each escaped, and trailing spaces — which git would
/// trim — kept by escaping them too.
fn literal(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len());
    for c in path.chars() {
        if matches!(c, '\\' | '*' | '?' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    let kept = escaped.trim_end_matches(' ');
    let spaces = escaped.len() - kept.len();
    format!("{kept}{}", "\\ ".repeat(spaces))
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A fake linked-worktree checkout: `main/.git/` (common dir) plus a
    /// worktree whose `.git` FILE points at `main/.git/worktrees/wt` with a
    /// `commondir` back-pointer — the layout `git worktree add` produces,
    /// built by hand so the test needs no git binary.
    pub(crate) fn fake_worktree(base: &Path) -> PathBuf {
        let common = base.join("main").join(".git");
        let gitdir = common.join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        wt
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git").args(args).current_dir(dir).output().unwrap().status.success()
    }

    /// Whether git, asked for real, ignores `path` (relative to `repo`).
    fn ignored(repo: &Path, path: &str) -> bool {
        git(repo, &["check-ignore", "-q", "--no-index", path])
    }

    fn file(path: &str) -> Excluded {
        Excluded { path: path.into(), directory: false }
    }

    #[test]
    fn a_name_holding_gits_wildcards_is_hidden_as_itself_and_as_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        assert!(git(&repo, &["init", "-q"]));
        let cases = [
            ("skills/review[old]", ["skills/reviewo", "skills/reviewd"]),
            ("skills/a*b", ["skills/axxb", "skills/ab"]),
            ("skills/q?", ["skills/qq", "skills/q"]),
            ("skills/back\\slash", ["skills/backslash", "skills/back/slash"]),
            ("skills/trailing ", ["skills/trailing", "skills/trailing  "]),
        ];
        for (name, _) in &cases {
            ensure_excluded(&repo, &file(name)).unwrap();
        }
        for (name, others) in &cases {
            assert!(ignored(&repo, name), "{name:?} itself is hidden");
            for other in others {
                assert!(!ignored(&repo, other), "{other:?} is not hidden by {name:?}");
            }
        }
    }

    #[test]
    fn the_cwds_place_below_the_root_is_literal_too_and_a_directory_is_only_a_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let cwd = repo.join("pkg[1]");
        fs::create_dir_all(&cwd).unwrap();
        assert!(git(&repo, &["init", "-q"]));
        ensure_excluded(&cwd, &Excluded { path: ".k".into(), directory: true }).unwrap();
        fs::create_dir_all(cwd.join(".k")).unwrap();
        fs::create_dir_all(repo.join("pkg1/.k")).unwrap();
        assert!(ignored(&repo, "pkg[1]/.k/a"));
        assert!(!ignored(&repo, "pkg1/.k/a"));
        let (_, line) = exclusion(&cwd, &Excluded { path: ".k".into(), directory: true }).unwrap().unwrap();
        assert_eq!(line, "/pkg\\[1\\]/.k/");
    }
}
