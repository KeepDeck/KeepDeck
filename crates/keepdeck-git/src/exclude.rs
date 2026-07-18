//! The repo-local ignore file (`info/exclude`) and the git-dir resolution it
//! needs — the ONE sanctioned way KeepDeck edits a file inside the user's
//! `.git`. Pure std-fs plumbing (no `git` subprocess): resolving a worktree's
//! `.git` FILE through its `gitdir:` pointer and `commondir` back-pointer is
//! documented stable git layout, and the exclude file is plain text.
//!
//! Byte fidelity is the contract: `ensure_line` appends without rewriting
//! anything, and `remove_line` drops ONLY the matched line while every other
//! byte — CRLF endings, comments, a missing final newline — survives
//! untouched. The user's exclude file is theirs; KeepDeck edits its own line.

use std::fs;
use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};

/// The repo owning `path`: its COMMON git dir plus `path`'s location below
/// the repo root, with components joined by `/` regardless of platform —
/// exclude patterns are git syntax, which only knows forward slashes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwningRepo {
    /// The shared `.git` directory (a linked worktree's `commondir` target).
    pub common_dir: PathBuf,
    /// `path` relative to the repo root as a git-syntax prefix (`""` for the
    /// root itself, `"packages/app"` for a subdir), always `/`-separated.
    pub below_root: String,
}

/// Resolve the repo owning `path` by walking ancestors for a `.git` entry —
/// a directory (ordinary checkout) or a file (`gitdir:` pointer of a linked
/// worktree, whose gitdir may carry a `commondir` back-pointer to the main
/// `.git`). `None` when no ancestor is a git checkout.
pub fn owning_repo(path: &Path) -> io::Result<Option<OwningRepo>> {
    for ancestor in path.ancestors() {
        let dotgit = ancestor.join(".git");
        let common_dir = if dotgit.is_dir() {
            dotgit
        } else {
            let pointer = match fs::read_to_string(&dotgit) {
                Ok(text) => text,
                Err(e) if e.kind() == ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            let Some(gitdir) = pointer.trim().strip_prefix("gitdir:") else {
                continue;
            };
            let gitdir = ancestor.join(gitdir.trim());
            match fs::read_to_string(gitdir.join("commondir")) {
                Ok(rel) => gitdir.join(rel.trim()),
                Err(e) if e.kind() == ErrorKind::NotFound => gitdir,
                Err(e) => return Err(e),
            }
        };
        let below_root = path
            .strip_prefix(ancestor)
            .map(|p| {
                p.components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_default();
        return Ok(Some(OwningRepo { common_dir, below_root }));
    }
    Ok(None)
}

/// Idempotently append `line` to the repo's `info/exclude`. The existing
/// content is preserved byte-for-byte; only the new line (and a separating
/// newline when the file didn't end with one) is added.
pub fn ensure_line(common_dir: &Path, line: &str) -> io::Result<()> {
    let exclude = exclude_path(common_dir);
    let current = match fs::read_to_string(&exclude) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    if current.lines().any(|l| l.trim() == line) {
        return Ok(());
    }
    let sep = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    write_atomic(&exclude, format!("{current}{sep}{line}\n").as_bytes())
}

/// Remove exactly the line matching `line` (trimmed comparison). Every other
/// byte survives untouched — a CRLF file keeps its CRLF endings, trailing
/// blank lines and a missing final newline stay as they were.
pub fn remove_line(common_dir: &Path, line: &str) -> io::Result<()> {
    let exclude = exclude_path(common_dir);
    let current = match fs::read_to_string(&exclude) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let mut kept = String::with_capacity(current.len());
    let mut removed = false;
    for segment in current.split_inclusive('\n') {
        if segment.trim_end_matches(['\n', '\r']).trim() == line {
            removed = true;
            continue;
        }
        kept.push_str(segment);
    }
    if !removed {
        return Ok(());
    }
    write_atomic(&exclude, kept.as_bytes())
}

fn exclude_path(common_dir: &Path) -> PathBuf {
    common_dir.join("info").join("exclude")
}

/// tmp + fsync + rename, so a crash mid-write can never tear the user's
/// exclude file (the crate stays dependency-free, hence its own copy).
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let tmp = path.with_file_name(name);
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn resolves_a_plain_checkout_and_a_subdir() {
        let dir = tmp();
        let repo = dir.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let sub = repo.join("packages").join("app");
        fs::create_dir_all(&sub).unwrap();

        let at_root = owning_repo(&repo).unwrap().unwrap();
        assert_eq!(at_root.common_dir, repo.join(".git"));
        assert_eq!(at_root.below_root, "");

        let at_sub = owning_repo(&sub).unwrap().unwrap();
        assert_eq!(at_sub.common_dir, repo.join(".git"));
        assert_eq!(at_sub.below_root, "packages/app");
    }

    #[test]
    fn resolves_a_linked_worktree_through_gitdir_and_commondir() {
        let dir = tmp();
        let common = dir.path().join("main").join(".git");
        let gitdir = common.join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let wt = dir.path().join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();

        let owning = owning_repo(&wt).unwrap().unwrap();
        assert_eq!(fs::canonicalize(&owning.common_dir).unwrap(), fs::canonicalize(&common).unwrap());
        assert_eq!(owning.below_root, "");
    }

    #[test]
    fn no_git_anywhere_resolves_to_none() {
        let dir = tmp();
        let plain = dir.path().join("plain");
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(owning_repo(&plain).unwrap(), None);
    }

    #[test]
    fn ensure_is_idempotent_and_remove_keeps_every_other_byte() {
        let dir = tmp();
        let common = dir.path().join(".git");
        let exclude = common.join("info").join("exclude");
        fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        // A CRLF file with a comment and NO final newline — every byte of it
        // must survive an add/remove cycle of OUR line.
        let user_bytes = "# mine\r\n*.log\r\nlast-line-no-newline";
        fs::write(&exclude, user_bytes).unwrap();

        ensure_line(&common, "/.agents/").unwrap();
        ensure_line(&common, "/.agents/").unwrap(); // idempotent
        let armed = fs::read_to_string(&exclude).unwrap();
        assert!(armed.starts_with(user_bytes));
        assert_eq!(armed.matches("/.agents/").count(), 1);

        remove_line(&common, "/.agents/").unwrap();
        assert_eq!(fs::read_to_string(&exclude).unwrap(), format!("{user_bytes}\n"));
        // The one byte we cannot restore: the separating newline our append
        // added before our line. Everything of the USER's — CRLF endings
        // included — is byte-identical.

        remove_line(&common, "/.agents/").unwrap(); // absent is fine
    }
}
