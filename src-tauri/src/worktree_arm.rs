//! Keeping git blind to what KeepDeck plants inside a pane's working
//! directory ([`crate::cwd_arm`]): an anchored line in the owning repo's
//! SHARED `info/exclude`, added when something is planted and removed when
//! nothing of ours is left under it.

use std::io;
use std::path::{Path, PathBuf};

/// Idempotently append the armed directory's anchored line to the owning
/// repo's SHARED `info/exclude`, so what was planted never shows up in git
/// status or a commit. A cwd outside any checkout simply has nowhere to write
/// and is left alone.
pub(crate) fn ensure_excluded(armed_root: &Path, planted: &str) -> io::Result<()> {
    match exclusion(armed_root, planted)? {
        Some((common_dir, line)) => keepdeck_git::exclude::ensure_line(&common_dir, &line),
        None => Ok(()),
    }
}

/// Remove the exact line arming appended — nothing else in the user's exclude
/// file is touched (byte-faithful removal lives in `keepdeck_git::exclude`).
pub(crate) fn remove_excluded(armed_root: &Path, planted: &str) -> io::Result<()> {
    match exclusion(armed_root, planted)? {
        Some((common_dir, line)) => keepdeck_git::exclude::remove_line(&common_dir, &line),
        None => Ok(()),
    }
}

/// The owning repo's COMMON git dir plus the anchored ignore pattern for an
/// armed cwd — `/<planted>/` at the repo root, `/<subdir>/<planted>/` below
/// it (forward slashes on every platform: the pattern is git syntax) — or
/// `None` when no ancestor is a git checkout.
fn exclusion(armed_root: &Path, planted: &str) -> io::Result<Option<(PathBuf, String)>> {
    let Some(repo) = keepdeck_git::exclude::owning_repo(armed_root)? else {
        return Ok(None);
    };
    let line = if repo.below_root.is_empty() {
        format!("/{planted}/")
    } else {
        format!("/{}/{planted}/", repo.below_root)
    };
    Ok(Some((repo.common_dir, line)))
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
