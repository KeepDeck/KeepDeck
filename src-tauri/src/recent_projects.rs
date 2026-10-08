//! The projects agents have worked in, newest first — the welcome screen's
//! list. Folders come from the session index (`keepdeck-index`), each is
//! told to its project (`keepdeck_git::project::project_root`: a worktree,
//! or a folder below a checkout, is the main checkout's), and a project
//! gathers every session of every folder that is part of it. A folder no
//! longer on disk is no project to open, and leaves with its sessions; the
//! filesystem root and the home folder hold sessions but are no project.

use std::path::Path;

use keepdeck_index::FolderActivity;
use serde::Serialize;
use tauri::State;

use crate::history::{with_index, HistoryIndex};

/// One project as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    /// The project's folder — the main checkout, for a repository.
    pub root: String,
    /// Sessions in it and in every folder that is part of it.
    pub sessions: i64,
    /// The newest of those sessions' last activity (the index's `mtime`).
    pub last_at: i64,
}

/// Gather `folders` into projects: `project_of` tells a folder's project,
/// `None` for one no longer there. Projects whose folder is in `not_projects`
/// (`/`, the home folder) are dropped. Newest first, then by folder.
pub fn fold_projects(
    folders: &[FolderActivity],
    project_of: impl Fn(&str) -> Option<String>,
    not_projects: &[String],
) -> Vec<RecentProject> {
    let mut projects: Vec<RecentProject> = Vec::new();
    for folder in folders {
        let Some(root) = project_of(&folder.cwd) else {
            continue;
        };
        if not_projects.contains(&root) {
            continue;
        }
        match projects.iter_mut().find(|project| project.root == root) {
            Some(project) => {
                project.sessions += folder.sessions;
                project.last_at = project.last_at.max(folder.last_mtime);
            }
            None => projects.push(RecentProject {
                root,
                sessions: folder.sessions,
                last_at: folder.last_mtime,
            }),
        }
    }
    projects.sort_by(|a, b| b.last_at.cmp(&a.last_at).then_with(|| a.root.cmp(&b.root)));
    projects
}

/// Every project agents have worked in, newest first ([`fold_projects`]).
/// `(async)`: it reads the index and a `.git` per folder — off the main
/// thread.
#[tauri::command(async)]
pub fn recent_projects(state: State<'_, HistoryIndex>) -> Result<Vec<RecentProject>, String> {
    let folders = with_index(&state, |index| index.folder_activity())?;
    let mut not_projects = vec!["/".to_string()];
    if let Some(home) = std::env::var_os("HOME") {
        not_projects.push(home.to_string_lossy().trim_end_matches('/').to_string());
    }
    Ok(fold_projects(&folders, project_of, &not_projects))
}

/// A folder's project, or `None` when it is no longer a folder on disk.
fn project_of(cwd: &str) -> Option<String> {
    let path = Path::new(cwd);
    if !path.is_dir() {
        return None;
    }
    let root = keepdeck_git::project::project_root(path).ok()?;
    Some(root.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(cwd: &str, sessions: i64, last_mtime: i64) -> FolderActivity {
        FolderActivity {
            cwd: cwd.into(),
            sessions,
            last_mtime,
        }
    }

    fn project(root: &str, sessions: i64, last_at: i64) -> RecentProject {
        RecentProject {
            root: root.into(),
            sessions,
            last_at,
        }
    }

    /// The projects as a test lays them out: a worktree and a subfolder of
    /// `/repo`, a folder gone from disk, and folders that are their own.
    fn project_of(cwd: &str) -> Option<String> {
        match cwd {
            "/wt/repo-1" | "/repo/src" | "/repo" => Some("/repo".into()),
            "/wt/gone" => None,
            other => Some(other.into()),
        }
    }

    #[test]
    fn gathers_every_folder_of_a_project_its_sessions_summed_its_newest_kept() {
        // In no particular order: the newest of a project's folders is
        // not necessarily the first one met.
        let folders = [
            folder("/repo", 3, 10),
            folder("/notes", 2, 50),
            folder("/wt/repo-1", 5, 90),
            folder("/repo/src", 1, 40),
        ];
        assert_eq!(
            fold_projects(&folders, project_of, &[]),
            vec![project("/repo", 9, 90), project("/notes", 2, 50)]
        );
    }

    #[test]
    fn drops_a_folder_gone_from_disk_and_what_is_no_project() {
        let folders = [
            folder("/wt/gone", 7, 99),
            folder("/Users/me", 4, 80),
            folder("/", 1, 70),
            folder("/notes", 1, 10),
        ];
        assert_eq!(
            fold_projects(&folders, project_of, &["/".into(), "/Users/me".into()]),
            vec![project("/notes", 1, 10)]
        );
    }

    #[test]
    fn orders_newest_first_and_a_tie_by_folder() {
        let folders = [
            folder("/b", 1, 10),
            folder("/a", 1, 10),
            folder("/c", 1, 20),
        ];
        assert_eq!(
            fold_projects(&folders, project_of, &[]),
            vec![
                project("/c", 1, 20),
                project("/a", 1, 10),
                project("/b", 1, 10)
            ]
        );
    }
}
