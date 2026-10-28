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

pub(crate) fn dir_for(root: &Path, plugin_id: &str, ws_id: &str) -> Result<PathBuf, String> {
    if !is_plugin_id(plugin_id) {
        return Err(format!("unsafe plugin id: {plugin_id:?}"));
    }
    if !crate::fs_names::is_safe_segment(ws_id) {
        return Err(format!("unsafe workspace id: {ws_id:?}"));
    }
    let dir = root.join(plugin_id).join(ws_id);
    create_owner_only(root, &[plugin_id, ws_id]).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// The manifest's id grammar (`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`): dots
/// only between parts, so never `.`, `..` or a hidden name.
pub(crate) fn is_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id.split(['.', '-']).all(|part| {
            !part.is_empty() && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// `root` and each of `names` below it — KeepDeck's private subtree — made the
/// owner's alone: created 0700 when missing and, when it was there already,
/// held to 0700. Walked by descriptor, never by path: a level that is a
/// symlink, or is not this user's, refuses instead of being followed or
/// trusted. Above `root` nothing is touched but created.
#[cfg(unix)]
fn create_owner_only(root: &Path, names: &[&str]) -> io::Result<()> {
    use std::ffi::{CString, OsStr};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    let (Some(parent), Some(root_name)) = (root.parent(), root.file_name()) else {
        return Err(io::Error::other("the private root has no parent"));
    };
    fs::create_dir_all(parent)?;
    let mut at = OwnedFd::from(fs::File::open(parent)?);
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    let levels = std::iter::once(root_name).chain(names.iter().map(OsStr::new));
    for name in levels {
        let name = CString::new(name.as_bytes()).map_err(io::Error::other)?;
        // SAFETY: a live directory descriptor and a NUL-terminated name.
        if unsafe { libc::mkdirat(at.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            let e = io::Error::last_os_error();
            if e.kind() != io::ErrorKind::AlreadyExists {
                return Err(e);
            }
        }
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: as above; the result is checked before it is owned.
        let fd = unsafe { libc::openat(at.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a fresh descriptor nothing else owns.
        let level = unsafe { OwnedFd::from_raw_fd(fd) };
        let meta = fs::File::from(level.try_clone()?).metadata()?;
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != me {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "a level is not this user's"));
        }
        if meta.mode() & 0o777 != 0o700 {
            // SAFETY: a live descriptor of the level just checked.
            if unsafe { libc::fchmod(level.as_raw_fd(), 0o700) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        at = level;
    }
    Ok(())
}

#[cfg(not(unix))]
fn create_owner_only(root: &Path, names: &[&str]) -> io::Result<()> {
    fs::create_dir_all(names.iter().fold(root.to_path_buf(), |dir, name| dir.join(name)))
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

    #[cfg(unix)]
    #[test]
    fn a_level_that_was_already_there_is_held_to_the_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugin-workspaces");
        fs::create_dir_all(root.join("keepdeck.codex/ws-1")).unwrap();
        for level in [&root, &root.join("keepdeck.codex")] {
            fs::set_permissions(level, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let dir = dir_for(&root, "keepdeck.codex", "ws-1").unwrap();
        for level in [&root, &root.join("keepdeck.codex"), &dir] {
            assert_eq!(fs::metadata(level).unwrap().permissions().mode() & 0o777, 0o700, "{}", level.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_level_that_is_a_symlink_is_refused_not_followed() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugin-workspaces");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("keepdeck.codex")).unwrap();
        assert!(dir_for(&root, "keepdeck.codex", "ws-1").is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none(), "nothing made through it");
        assert_eq!(fs::metadata(&outside).unwrap().permissions().mode() & 0o777, 0o755, "nor its mode changed");
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
