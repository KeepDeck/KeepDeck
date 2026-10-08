//! Which project a directory is part of — the main checkout of its
//! repository. A linked worktree is the same project as the checkout it
//! was added from, and so is any folder below either; a folder in no
//! repository is a project of its own. Read from the `.git` layout
//! (`exclude::owning_repo`), never by running git: a list of projects asks
//! this of every folder agents ever worked in.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::exclude::owning_repo;

/// The project `path` is part of: the main checkout of the repository that
/// owns it, or `path` itself outside any repository — always RESOLVED
/// (symlinks followed), so a folder reached by two spellings (`/tmp` and
/// `/private/tmp`) is one project. The folder is resolved BEFORE its
/// repository is looked for: a symlink is the folder it points at, and the
/// repository is that folder's, not the one the link happens to sit in. A
/// bare repository has no main checkout: its worktrees stay projects of
/// their own.
pub fn project_root(path: &Path) -> io::Result<PathBuf> {
    let path = fs::canonicalize(path)?;
    let root = unresolved_root(&path)?;
    Ok(fs::canonicalize(&root).unwrap_or(root))
}

fn unresolved_root(path: &Path) -> io::Result<PathBuf> {
    let Some(repo) = owning_repo(path)? else {
        return Ok(path.to_path_buf());
    };
    let depth = repo
        .below_root
        .split('/')
        .filter(|part| !part.is_empty())
        .count();
    let checkout = path.ancestors().nth(depth).unwrap_or(path);
    if repo.common_dir == checkout.join(".git") {
        return Ok(checkout.to_path_buf());
    }
    let common = fs::canonicalize(&repo.common_dir).unwrap_or(repo.common_dir);
    if is_bare(&common) {
        return Ok(checkout.to_path_buf());
    }
    match (common.file_name(), common.parent()) {
        (Some(name), Some(main)) if name == ".git" => Ok(main.to_path_buf()),
        _ => Ok(checkout.to_path_buf()),
    }
}

/// Whether the repository at `common_dir` says it is bare (`core.bare` in
/// its config) — whatever its folder is called, `<holder>/.git` included.
fn is_bare(common_dir: &Path) -> bool {
    fs::read_to_string(common_dir.join("config"))
        .map(|config| core_bare(&config))
        .unwrap_or(false)
}

/// `core.bare` as git reads it from a config file: only in the `[core]`
/// section (not another, not a `[core "…"]` subsection), the last one
/// set winning, a comment (`#`, `;`) outside quotes ending the value,
/// quotes dropped, and git's booleans — true/yes/on, a nonzero integer
/// (`k`/`m`/`g` suffixes allowed), a bare key as true; anything else false.
fn core_bare(config: &str) -> bool {
    let mut in_core = false;
    let mut bare = false;
    for raw in config.lines() {
        let line = raw.trim();
        if let Some(header) = line.strip_prefix('[') {
            let name = header.split(']').next().unwrap_or("").trim();
            in_core = name.eq_ignore_ascii_case("core");
            continue;
        }
        if !in_core {
            continue;
        }
        let (key, value) = match line.split_once('=') {
            Some((key, value)) => (key.trim(), Some(config_value(value))),
            None => (uncommented(line).trim(), None),
        };
        if !key.eq_ignore_ascii_case("bare") {
            continue;
        }
        bare = value.is_none_or(|value| git_bool(&value));
    }
    bare
}

/// The text before a comment that starts outside quotes.
fn uncommented(text: &str) -> &str {
    let mut quoted = false;
    for (at, c) in text.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => return &text[..at],
            _ => {}
        }
    }
    text
}

/// A config value as git hands it on: the comment cut, the quotes dropped,
/// the ends trimmed.
fn config_value(raw: &str) -> String {
    uncommented(raw).trim().replace('"', "")
}

/// A config value read as git's boolean.
fn git_bool(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    match value.as_str() {
        "true" | "yes" | "on" => return true,
        "false" | "no" | "off" | "" => return false,
        _ => {}
    }
    let digits = value.trim_end_matches(['k', 'm', 'g']);
    digits.parse::<i64>().map(|n| n != 0).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A main checkout at `<dir>/main` and a linked worktree of it at
    /// `<dir>/wt`, laid out as `git worktree add` does.
    fn repo_with_worktree(dir: &Path) -> (PathBuf, PathBuf) {
        let main = dir.join("main");
        let gitdir = main.join(".git").join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let wt = dir.join("wt");
        fs::create_dir_all(wt.join("src")).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        (main, wt)
    }

    #[test]
    fn a_main_checkout_and_a_folder_below_it_are_the_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let (main, _) = repo_with_worktree(dir.path());
        let main = fs::canonicalize(main).unwrap();
        fs::create_dir_all(main.join("packages").join("app")).unwrap();
        assert_eq!(project_root(&main).unwrap(), main);
        assert_eq!(
            project_root(&main.join("packages").join("app")).unwrap(),
            main
        );
    }

    #[test]
    fn a_linked_worktree_and_a_folder_below_it_are_the_main_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let (main, wt) = repo_with_worktree(dir.path());
        let main = fs::canonicalize(main).unwrap();
        assert_eq!(project_root(&wt).unwrap(), main);
        assert_eq!(project_root(&wt.join("src")).unwrap(), main);
    }

    #[test]
    fn a_folder_in_no_repository_is_its_own_project() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("notes");
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(
            project_root(&plain).unwrap(),
            fs::canonicalize(plain).unwrap()
        );
    }

    #[test]
    fn a_worktree_of_a_bare_repository_is_its_own_project() {
        let dir = tempfile::tempdir().unwrap();
        let bare = dir.path().join("repo.git");
        let gitdir = bare.join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let wt = dir.path().join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        assert_eq!(project_root(&wt).unwrap(), fs::canonicalize(wt).unwrap());
    }

    #[test]
    fn reads_core_bare_as_git_does() {
        // Only [core]; the last set wins; a comment ends the value; git's booleans.
        assert!(!core_bare(
            "[core]\n\tbare = false\n[review]\n\tbare = true\n"
        ));
        assert!(core_bare("[core]\n\tbare = true # a comment\n"));
        assert!(core_bare("[core]\n\tbare = yes\n"));
        assert!(core_bare("[core]\n\tbare = 1\n"));
        assert!(!core_bare("[core]\n\tbare = true\n\tbare = false\n"));
        assert!(core_bare("[CORE]\n\tBare\n"));
        assert!(!core_bare("[core \"sub\"]\n\tbare = true\n"));
        assert!(!core_bare("[core]\n\trepositoryformatversion = 0\n"));
        // Quotes dropped, a comment sign inside them kept, any nonzero integer true.
        assert!(core_bare("[core]\n\tbare = \"true\"\n"));
        assert!(core_bare("[core]\n\tbare = 2\n"));
        assert!(core_bare("[core]\n\tbare = 1k\n"));
        assert!(!core_bare("[core]\n\tbare = 0\n"));
        assert!(!core_bare("[core]\n\tbare = \"no;\"\n"));
        assert!(!core_bare("[core]\n\tbare = maybe\n"));
    }

    #[test]
    fn a_bare_repository_named_dot_git_keeps_its_worktrees_their_own() {
        let dir = tempfile::tempdir().unwrap();
        let (main, wt) = repo_with_worktree(dir.path());
        fs::write(main.join(".git").join("config"), "[core]\n\tbare = true\n").unwrap();
        assert_eq!(project_root(&wt).unwrap(), fs::canonicalize(wt).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_the_folder_it_points_at_not_the_repository_it_sits_in() {
        let dir = tempfile::tempdir().unwrap();
        let (main, _) = repo_with_worktree(dir.path());
        let other = dir.path().join("other");
        fs::create_dir_all(other.join(".git")).unwrap();
        fs::create_dir_all(other.join("src")).unwrap();
        let link = main.join("foreign");
        std::os::unix::fs::symlink(other.join("src"), &link).unwrap();
        assert_eq!(
            project_root(&link).unwrap(),
            fs::canonicalize(&other).unwrap()
        );
        let outside = dir.path().join("into-main");
        fs::create_dir_all(main.join("src")).unwrap();
        std::os::unix::fs::symlink(main.join("src"), &outside).unwrap();
        assert_eq!(
            project_root(&outside).unwrap(),
            fs::canonicalize(&main).unwrap()
        );
    }

    #[test]
    fn a_folder_gone_from_disk_is_an_error_not_a_project() {
        let dir = tempfile::tempdir().unwrap();
        assert!(project_root(&dir.path().join("gone")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_checkout_reached_through_a_symlink_is_the_same_project() {
        let dir = tempfile::tempdir().unwrap();
        let (main, wt) = repo_with_worktree(dir.path());
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&main, &link).unwrap();
        assert_eq!(project_root(&link).unwrap(), project_root(&wt).unwrap());
    }
}
