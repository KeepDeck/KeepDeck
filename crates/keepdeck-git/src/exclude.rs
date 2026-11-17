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
/// `.git`). `None` when no ancestor is a git checkout. An ancestor that is
/// itself a regular FILE makes the `.git` read fail with ENOTDIR, which
/// propagates as an error rather than walking past — unreachable for real
/// cwds (every ancestor of a directory is a directory), deliberate for the
/// degenerate case: resolving PAST a broken component could land in the
/// wrong parent repo.
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

/// The comment KeepDeck writes right above a pattern it added: the proof the
/// pattern is ours to take out again. A pattern without it is the user's — or
/// an older build's, which wrote none and so can never be told apart.
pub const MANAGED: &str = "# keepdeck-managed";

/// Idempotently add `line` to the repo's `info/exclude` as KeepDeck's own:
/// [`MANAGED`] and the pattern, as one unit. When the file already has the
/// pattern — ours, or the user's — nothing is added, so a pattern the user
/// wrote stays theirs. The existing content is preserved byte-for-byte; only
/// the unit (and a separating newline when the file didn't end with one) is
/// added.
pub fn ensure_line(common_dir: &Path, line: &str) -> io::Result<()> {
    update(common_dir, &[line], &[]).map(drop)
}

/// Remove `line` only where it sits right below [`MANAGED`]. The same pattern
/// anywhere else is not ours and stays. Every other byte survives untouched —
/// a CRLF file keeps its CRLF endings, trailing blank lines and a missing
/// final newline stay as they were.
pub fn remove_line(common_dir: &Path, line: &str) -> io::Result<()> {
    update(common_dir, &[], &[line]).map(drop)
}

/// [`remove_line`] each of `remove` and [`ensure_line`] each of `add`, in ONE
/// read and at most one write of the file — none when nothing changes.
/// Patterns compare as git reads them ([`pattern`]). Answers whether the file
/// was written.
pub fn update(common_dir: &Path, add: &[&str], remove: &[&str]) -> io::Result<bool> {
    let exclude = exclude_path(common_dir);
    let current = match fs::read_to_string(&exclude) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let removing: Vec<&str> = remove.iter().map(|line| pattern(line)).collect();
    let segments: Vec<&str> = current.split_inclusive('\n').collect();
    let mut kept = String::with_capacity(current.len());
    let mut changed = false;
    let mut index = 0;
    while index < segments.len() {
        let ours = segments[index].trim() == MANAGED
            && segments.get(index + 1).is_some_and(|next| removing.contains(&pattern(next)));
        if ours {
            changed = true;
            index += 2;
            continue;
        }
        kept.push_str(segments[index]);
        index += 1;
    }
    for line in add {
        if kept.lines().any(|existing| pattern(existing) == pattern(line)) {
            continue;
        }
        if !kept.is_empty() && !kept.ends_with('\n') {
            kept.push('\n');
        }
        kept.push_str(&format!("{MANAGED}\n{line}\n"));
        changed = true;
    }
    if !changed {
        return Ok(false);
    }
    write_atomic(&exclude, kept.as_bytes()).map(|()| true)
}

/// A line of an exclude file as the pattern git reads from it: without its
/// line ending (`\n`, then one `\r`), and without trailing spaces — except one
/// a backslash escapes, which git keeps. Nothing else is trimmed: a leading
/// space or a trailing tab is part of the pattern. Two lines are one pattern
/// exactly when these agree, byte for byte.
pub fn pattern(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    let mut line = line.strip_suffix('\r').unwrap_or(line);
    while let Some(rest) = line.strip_suffix(' ') {
        let escapes = rest.len() - rest.trim_end_matches('\\').len();
        if escapes % 2 == 1 {
            break;
        }
        line = rest;
    }
    line
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

    #[test]
    fn a_pattern_without_our_marker_is_the_users_and_is_never_taken_out() {
        let dir = tmp();
        let common = dir.path().join(".git");
        let exclude = common.join("info").join("exclude");
        fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        fs::write(&exclude, "/.agents/\n").unwrap();

        // Already there as theirs: nothing added, so nothing becomes ours.
        ensure_line(&common, "/.agents/").unwrap();
        assert_eq!(fs::read_to_string(&exclude).unwrap(), "/.agents/\n");
        remove_line(&common, "/.agents/").unwrap();
        assert_eq!(fs::read_to_string(&exclude).unwrap(), "/.agents/\n");

        // Ours beside a copy of theirs: only our unit goes.
        fs::write(&exclude, "").unwrap();
        ensure_line(&common, "/.agents/").unwrap();
        let ours = fs::read_to_string(&exclude).unwrap();
        assert_eq!(ours, format!("{MANAGED}\n/.agents/\n"));
        fs::write(&exclude, format!("{ours}/.agents/\n")).unwrap();
        remove_line(&common, "/.agents/").unwrap();
        assert_eq!(fs::read_to_string(&exclude).unwrap(), "/.agents/\n");
    }

    #[test]
    fn a_pattern_is_what_git_reads_from_its_line() {
        assert_eq!(pattern("/a\r\n"), "/a");
        assert_eq!(pattern("/a  "), "/a", "unescaped trailing spaces are not the pattern");
        assert_eq!(pattern("/a\\ "), "/a\\ ", "an escaped one is");
        assert_eq!(pattern("/a\\  "), "/a\\ ", "only the escaped one of two");
        assert_eq!(pattern("/a\\\\ "), "/a\\\\", "an escaped backslash escapes no space");
        assert_eq!(pattern(" /a"), " /a", "a leading space is part of it");
        assert_eq!(pattern("/a\t"), "/a\t", "and so is a trailing tab");
    }

    #[test]
    fn an_escaped_trailing_space_is_its_own_pattern_added_once_and_taken_out_again() {
        let dir = tmp();
        let common = dir.path().join(".git");
        ensure_line(&common, "/skills/a\\ ").unwrap();
        ensure_line(&common, "/skills/a\\ ").unwrap();
        ensure_line(&common, "/skills/a").unwrap();
        let exclude = common.join("info").join("exclude");
        let text = fs::read_to_string(&exclude).unwrap();
        assert_eq!(text, format!("{MANAGED}\n/skills/a\\ \n{MANAGED}\n/skills/a\n"));
        remove_line(&common, "/skills/a\\ ").unwrap();
        assert_eq!(fs::read_to_string(&exclude).unwrap(), format!("{MANAGED}\n/skills/a\n"));
    }

    #[test]
    fn one_update_takes_out_and_adds_in_a_single_write_and_none_when_nothing_changes() {
        let dir = tmp();
        let common = dir.path().join(".git");
        ensure_line(&common, "/old").unwrap();
        assert!(update(&common, &["/new/a", "/new/b"], &["/old"]).unwrap());
        let exclude = common.join("info").join("exclude");
        assert_eq!(fs::read_to_string(&exclude).unwrap(), format!("{MANAGED}\n/new/a\n{MANAGED}\n/new/b\n"));
        // Nothing to change: the file is not written at all.
        use std::os::unix::fs::PermissionsExt;
        let info = common.join("info");
        fs::set_permissions(&info, fs::Permissions::from_mode(0o555)).unwrap();
        let unchanged = update(&common, &["/new/a"], &["/gone"]);
        fs::set_permissions(&info, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!unchanged.unwrap(), "nothing written");
    }
}
