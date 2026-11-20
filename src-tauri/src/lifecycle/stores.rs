//! The lifecycle's doors to what it forgets outside git: the stores of Rust
//! and what plugins planted. A port of its own, so the git and the session
//! doors work without the app around them. The app's side reaches each
//! store through its managed state, and each store forgets under its own
//! lock — the one its writes take.

use crate::artifacts::ArtifactsState;
use crate::mcp::library::McpLibraryLock;
use crate::plugin_permissions::PluginGrants;
use crate::plugin_workspaces::PluginDirsLock;
use crate::skills::SkillsLocks;
use keepdeck_lifecycle::dir::Dir;
use keepdeck_lifecycle::ids::WorkspaceId;
use tauri::Manager;

pub trait StoreDoors: Send + Sync + 'static {
    /// Take back everything planted in a folder a close takes back.
    fn disarm(&self, dir: &Dir) -> Result<(), String>;
    /// A closed workspace's data goes from every store that keeps it: its
    /// artifacts, its MCP scope, its skills staging, every plugin's folder
    /// of it, what was planted for it. Its authored skills stay.
    fn forget(&self, workspace: &WorkspaceId) -> Result<(), String>;
    /// Boot's reconciliation: the derived data of every workspace not among
    /// these goes. Boards and artifacts never go by absence.
    fn retain(&self, workspaces: &[WorkspaceId]) -> Result<(), String>;
    /// A fork's scaffolding goes, removed the way its plugin would remove it.
    fn discard(&self, plugin: &str, paths: &[String]) -> Result<(), String>;
}

/// Every step tried; the ones that failed said together, each by its store.
pub(crate) fn each(steps: impl IntoIterator<Item = (&'static str, Result<(), String>)>) -> Result<(), String> {
    let failed: Vec<String> = steps.into_iter().filter_map(|(store, result)| result.err().map(|why| format!("{store}: {why}"))).collect();
    if failed.is_empty() {
        Ok(())
    } else {
        Err(failed.join("; "))
    }
}

pub struct AppStores {
    app: tauri::AppHandle,
}

impl AppStores {
    pub fn new(app: tauri::AppHandle) -> AppStores {
        AppStores { app }
    }
}

impl StoreDoors for AppStores {
    fn disarm(&self, dir: &Dir) -> Result<(), String> {
        crate::cwd_arm::disarm_dir(dir.as_str())
    }

    fn forget(&self, workspace: &WorkspaceId) -> Result<(), String> {
        let ws = workspace.0.as_str();
        let (dirs_lock, grants) = (self.app.state::<PluginDirsLock>(), self.app.state::<PluginGrants>());
        each([
            ("artifacts", self.app.state::<ArtifactsState>().drop_workspace(ws)),
            ("MCP library", crate::mcp::library::forget_scope(&self.app.state::<McpLibraryLock>(), ws)),
            ("skills staging", crate::skills::forget_staging(&self.app.state::<SkillsLocks>(), ws)),
            ("plugin folders", crate::plugin_workspaces::forget_workspace(&dirs_lock, &grants, ws)),
            ("plantings", crate::cwd_arm::forget(ws)),
        ])
    }

    fn retain(&self, workspaces: &[WorkspaceId]) -> Result<(), String> {
        let live: Vec<String> = workspaces.iter().map(|ws| ws.0.clone()).collect();
        let (dirs_lock, grants) = (self.app.state::<PluginDirsLock>(), self.app.state::<PluginGrants>());
        each([
            ("MCP library", crate::mcp::library::retain_scopes(&self.app.state::<McpLibraryLock>(), &live)),
            ("skills staging", crate::skills::retain_stagings(&self.app.state::<SkillsLocks>(), &live)),
            ("plugin folders", crate::plugin_workspaces::retain_workspaces(&dirs_lock, &grants, &live)),
            ("plantings", crate::cwd_arm::retain(&live)),
        ])
    }

    fn discard(&self, plugin: &str, paths: &[String]) -> Result<(), String> {
        let (dirs_lock, grants) = (self.app.state::<PluginDirsLock>(), self.app.state::<PluginGrants>());
        each(paths.iter().map(|path| ("fork scaffolding", crate::plugins_fs_write::remove_as(&dirs_lock, &grants, plugin, path))))
    }
}

#[cfg(test)]
mod tests {
    use super::each;

    #[test]
    fn every_step_is_tried_and_each_failure_is_said_by_its_store() {
        assert_eq!(each([("a", Ok(())), ("b", Ok(()))]), Ok(()));
        assert_eq!(each([("a", Err("off".into())), ("b", Ok(())), ("c", Err("busy".into()))]), Err("a: off; c: busy".into()));
    }
}
