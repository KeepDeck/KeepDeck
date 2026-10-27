//! A plugin's private directory per workspace:
//! `<KEEPDECK_HOME>/plugin-workspaces/<pluginId>/<workspaceId>/`.
//!
//! Durable data a plugin builds for one workspace — a layout it hands its CLI,
//! say — lives here, outside every repository, so nothing in it needs a git
//! exclude. The directory is made on the first ask, never at activation, and
//! goes with its workspace: the deck's sweep prunes every plugin's directory
//! of a workspace id the deck no longer holds, which covers a deleted
//! workspace and a crash's leftovers by one rule, without enumerating plugins.
//!
//! The ids are path segments. The host passes the plugin id from its registry
//! and the workspace id from its deck — never a plugin's words — and both are
//! held to their grammars here all the same: this is the one place they turn
//! into a path.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The directory for `plugin_id` and `ws_id`, created when missing.
#[tauri::command(async)]
pub fn plugin_workspace_dir(plugin_id: String, ws_id: String) -> Result<String, String> {
    let dir = dir_for(&root()?, &plugin_id, &ws_id)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Drop every plugin's directory of a workspace the deck no longer holds.
/// Best-effort per directory: one that cannot go must not keep the rest.
#[tauri::command(async)]
pub fn plugin_workspaces_prune(live_ws_ids: Vec<String>) -> Result<(), String> {
    prune(&root()?, &live_ws_ids).map_err(|e| e.to_string())
}

fn root() -> Result<PathBuf, String> {
    let home = crate::paths::keepdeck_home().ok_or("no home directory for plugin workspaces")?;
    Ok(home.join("plugin-workspaces"))
}

fn dir_for(root: &Path, plugin_id: &str, ws_id: &str) -> Result<PathBuf, String> {
    if !is_plugin_id(plugin_id) {
        return Err(format!("unsafe plugin id: {plugin_id:?}"));
    }
    if !crate::fs_names::is_safe_segment(ws_id) {
        return Err(format!("unsafe workspace id: {ws_id:?}"));
    }
    let dir = root.join(plugin_id).join(ws_id);
    create_owner_only(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The manifest's id grammar (`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`): dots
/// only between parts, so never `.`, `..` or a hidden name.
fn is_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id.split(['.', '-']).all(|part| {
            !part.is_empty() && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// Every level this call creates is the owner's alone; a level that existed
/// keeps the mode it had.
fn create_owner_only(dir: &Path) -> io::Result<()> {
    let mut missing = Vec::new();
    let mut cursor = Some(dir);
    while let Some(level) = cursor {
        if level.exists() {
            break;
        }
        missing.push(level.to_path_buf());
        cursor = level.parent();
    }
    for level in missing.iter().rev() {
        match fs::create_dir(level) {
            Ok(()) => restrict(level),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn restrict(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = dir;
}

fn prune(root: &Path, live: &[String]) -> io::Result<()> {
    for plugin in crate::fs_names::sorted_dirs(root)? {
        for dir in crate::fs_names::sorted_dirs(&plugin)? {
            let id = dir.file_name().unwrap_or_default().to_string_lossy();
            if live.iter().any(|l| *l == id) {
                continue;
            }
            if let Err(e) = fs::remove_dir_all(&dir) {
                log::warn!("plugin workspaces: pruning {} failed: {e}", dir.display());
            }
        }
        // A plugin left with no workspace keeps no empty folder behind.
        let _ = fs::remove_dir(&plugin);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_the_dir_on_ask_under_its_plugin_and_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugin-workspaces");
        let dir = dir_for(&root, "keepdeck.claude", "ws-1").unwrap();
        assert_eq!(dir, root.join("keepdeck.claude").join("ws-1"));
        assert!(dir.is_dir());
        // Asking again is the same directory, untouched.
        fs::write(dir.join("kept"), "x").unwrap();
        assert_eq!(dir_for(&root, "keepdeck.claude", "ws-1").unwrap(), dir);
        assert!(dir.join("kept").exists());
    }

    #[cfg(unix)]
    #[test]
    fn what_it_creates_is_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugin-workspaces");
        let dir = dir_for(&root, "keepdeck.codex", "ws-1").unwrap();
        for level in [&root, &root.join("keepdeck.codex"), &dir] {
            let mode = fs::metadata(level).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{}", level.display());
        }
    }

    #[test]
    fn refuses_an_id_that_is_not_one_path_segment() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugin-workspaces");
        for plugin in ["", "..", ".", "a/b", "../x", "A", "a..b", ".hidden", "a.", "-a"] {
            assert!(dir_for(&root, plugin, "ws-1").is_err(), "{plugin:?}");
        }
        for ws in ["", "..", "a/b", "../x", ".x"] {
            assert!(dir_for(&root, "keepdeck.git", ws).is_err(), "{ws:?}");
        }
        assert!(!root.exists(), "a refused ask creates nothing");
    }

    #[test]
    fn prune_drops_every_plugins_dir_of_a_departed_workspace_and_keeps_the_live() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugin-workspaces");
        for plugin in ["keepdeck.claude", "keepdeck.opencode"] {
            for ws in ["ws-1", "ws-2"] {
                fs::write(dir_for(&root, plugin, ws).unwrap().join("f"), "x").unwrap();
            }
        }
        dir_for(&root, "keepdeck.kimi", "ws-2").unwrap();
        prune(&root, &["ws-1".to_string()]).unwrap();
        assert!(root.join("keepdeck.claude/ws-1/f").exists());
        assert!(root.join("keepdeck.opencode/ws-1/f").exists());
        assert!(!root.join("keepdeck.claude/ws-2").exists());
        assert!(!root.join("keepdeck.opencode/ws-2").exists());
        assert!(!root.join("keepdeck.kimi").exists(), "an emptied plugin folder goes too");
    }

    #[test]
    fn prune_of_nothing_is_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        prune(&tmp.path().join("absent"), &[]).unwrap();
    }
}
