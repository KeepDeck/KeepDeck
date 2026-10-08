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
/// owns it, or `path` itself outside any repository. A main checkout keeps
/// the spelling of the path it was reached by; a linked worktree's is the
/// resolved path of its repository's shared `.git` directory's parent. A
/// bare repository has no main checkout: its worktrees stay projects of
/// their own.
pub fn project_root(path: &Path) -> io::Result<PathBuf> {
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
    match (common.file_name(), common.parent()) {
        (Some(name), Some(main)) if name == ".git" => Ok(main.to_path_buf()),
        _ => Ok(checkout.to_path_buf()),
    }
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
        assert_eq!(project_root(&plain).unwrap(), plain);
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
        assert_eq!(project_root(&wt).unwrap(), wt);
    }
}
