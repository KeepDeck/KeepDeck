//! A plugin's private directory per workspace:
//! `<KEEPDECK_HOME>/plugin-workspaces/<pluginId>/<workspaceId>/`.
//!
//! Durable data a plugin builds for one workspace — a layout it hands its CLI,
//! say — lives here, outside every repository, so nothing in it needs a git
//! exclude. The directory is made on the first ask, never at activation, and
//! goes with its workspace — every plugin's directory of it, without
//! enumerating plugins: when the workspace is closed ([`forget`]), and at
//! boot for every workspace id nothing holds any more ([`retain`]). None is
//! made for a forgotten workspace. All of it, and every write the broker
//! does, runs under one lock ([`PluginDirsLock`]).
//!
//! The ids are path segments. The host passes the plugin id from its registry
//! and the workspace id from its deck — never a plugin's words — and both are
//! held to their grammars here all the same: this is the one place they turn
//! into a path.
//!
//! A directory handed out joins the plugin's grant as a write root, and
//! leaves it with its workspace — before the directory itself goes.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tauri::State;

use crate::forgotten::{Gate, Source};
use crate::plugin_permissions::PluginGrants;

/// The one lock over plugins' workspace directories: their making and
/// handing out, every write the broker does in a plugin's roots — the roots
/// taken under it — and their removal. A write that took a directory's root
/// before its removal finishes first and goes with it; the next write no
/// longer holds the root.
#[derive(Default)]
pub struct PluginDirsLock(Mutex<()>);

impl PluginDirsLock {
    pub(crate) fn hold(&self) -> MutexGuard<'_, ()> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The directory for `plugin_id` and `ws_id`, created when missing, and
/// from now on one the plugin may write in.
#[tauri::command(async)]
pub fn plugin_workspace_dir(
    lock: State<'_, PluginDirsLock>,
    grants: State<'_, PluginGrants>,
    gate: State<'_, Gate>,
    plugin_id: String,
    ws_id: String,
) -> Result<String, String> {
    hand_out(&lock, &grants, &gate, &root()?, &plugin_id, &ws_id)
}

/// Make and hand out a directory — none for a forgotten workspace, whose
/// directories its forgetting removes under this same lock.
fn hand_out(lock: &PluginDirsLock, grants: &PluginGrants, gate: &Gate, root: &Path, plugin_id: &str, ws_id: &str) -> Result<String, String> {
    let _held = lock.hold();
    gate.admit(&Source::from(ws_id)).map_err(|refused| refused.to_string())?;
    let dir = dir_for(root, plugin_id, ws_id)?.to_string_lossy().into_owned();
    grants.hand_workspace(plugin_id, ws_id, dir.clone());
    Ok(dir)
}

/// Keep only the `live` workspaces' directories — boot's reconciliation.
pub(crate) fn retain_workspaces(lock: &PluginDirsLock, grants: &PluginGrants, live: &[String]) -> Result<(), String> {
    retain(lock, grants, &root()?, live).map_err(|e| e.to_string())
}

/// A closed workspace's directories go, every plugin's.
pub(crate) fn forget_workspace(lock: &PluginDirsLock, grants: &PluginGrants, ws_id: &str) -> Result<(), String> {
    forget(lock, grants, &root()?, ws_id).map_err(|e| e.to_string())
}

/// Keep only the directories of the `live` workspaces.
fn retain(lock: &PluginDirsLock, grants: &PluginGrants, root: &Path, live: &[String]) -> io::Result<()> {
    drop_dirs(lock, grants, root, |ws_id| !live.iter().any(|l| l == ws_id))
}

/// Every plugin's directory of one workspace goes.
pub(crate) fn forget(lock: &PluginDirsLock, grants: &PluginGrants, root: &Path, ws_id: &str) -> io::Result<()> {
    drop_dirs(lock, grants, root, |id| id == ws_id)
}

/// Under the lock: the grants of the `gone` workspaces' directories let go
/// first, then the directories themselves.
fn drop_dirs(lock: &PluginDirsLock, grants: &PluginGrants, root: &Path, gone: impl Fn(&str) -> bool) -> io::Result<()> {
    let _held = lock.hold();
    grants.release_workspaces(&gone);
    prune(root, gone)
}

fn root() -> Result<PathBuf, String> {
    let home = crate::paths::keepdeck_home().ok_or("no home directory for plugin workspaces")?;
    Ok(root_in(&home))
}

/// Where every plugin's workspace directories live under KeepDeck's `home`.
fn root_in(home: &Path) -> PathBuf {
    home.join("plugin-workspaces")
}

/// The workspace whose plugin directory holds the real path `real` — one
/// under `<home>/plugin-workspaces/<plugin>/<workspace>` — if one does.
pub(crate) fn workspace_holding(real: &Path) -> Option<String> {
    workspace_under(&real_root()?, real)
}

/// Whether the real path `real` holds workspaces' plugin directories
/// without being inside one: their root, a plugin's level in it, or
/// anything above the root. Those levels are KeepDeck's to make and remove;
/// what is inside one workspace's directory is that workspace's.
pub(crate) fn holds_workspace_dirs(real: &Path) -> bool {
    real_root().is_some_and(|root| holds_under(&root, real))
}

fn real_root() -> Option<PathBuf> {
    let root = root().ok()?;
    Some(crate::containment::real_prefix(&root).unwrap_or(root))
}

fn workspace_under(root: &Path, real: &Path) -> Option<String> {
    let mut parts = real.strip_prefix(root).ok()?.components();
    let _plugin = parts.next()?;
    Some(parts.next()?.as_os_str().to_string_lossy().into_owned())
}

fn holds_under(root: &Path, real: &Path) -> bool {
    root.starts_with(real) || real.strip_prefix(root).is_ok_and(|level| level.components().count() < 2)
}

/// The path of `plugin_id`'s directory for `ws_id` under `home` — the
/// directory itself is made only by [`plugin_workspace_dir`].
pub(crate) fn path_in(home: &Path, plugin_id: &str, ws_id: &str) -> PathBuf {
    of(&root_in(home), plugin_id, ws_id)
}

fn of(root: &Path, plugin_id: &str, ws_id: &str) -> PathBuf {
    root.join(plugin_id).join(ws_id)
}

pub(crate) fn dir_for(root: &Path, plugin_id: &str, ws_id: &str) -> Result<PathBuf, String> {
    if !is_plugin_id(plugin_id) {
        return Err(format!("unsafe plugin id: {plugin_id:?}"));
    }
    if !crate::fs_names::is_safe_segment(ws_id) {
        return Err(format!("unsafe workspace id: {ws_id:?}"));
    }
    let dir = of(root, plugin_id, ws_id);
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

fn prune(root: &Path, gone: impl Fn(&str) -> bool) -> io::Result<()> {
    let mut leaving = Vec::new();
    let plugins = crate::fs_names::sorted_dirs(root)?;
    for plugin in &plugins {
        for dir in crate::fs_names::sorted_dirs(plugin)? {
            if gone(&dir.file_name().unwrap_or_default().to_string_lossy()) {
                leaving.push(dir);
            }
        }
    }
    let removed = crate::fs_names::remove_each(leaving, |dir| fs::remove_dir_all(dir));
    // A plugin left with no workspace keeps no empty folder behind.
    for plugin in &plugins {
        let _ = fs::remove_dir(plugin);
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The root and a plugin's level hold workspaces' directories, and so
    /// does anything above the root; a workspace's directory and what is in
    /// it are that workspace's.
    #[test]
    fn the_levels_above_a_workspaces_directory_are_keepdecks() {
        let root = Path::new("/home/kd/plugin-workspaces");
        for level in ["/", "/home/kd", "/home/kd/plugin-workspaces", "/home/kd/plugin-workspaces/keepdeck.claude"] {
            assert!(holds_under(root, Path::new(level)), "{level}");
        }
        for inside in ["/home/kd/plugin-workspaces/keepdeck.claude/ws-1", "/home/kd/plugin-workspaces/keepdeck.claude/ws-1/notes", "/home/kd/elsewhere"] {
            assert!(!holds_under(root, Path::new(inside)), "{inside}");
        }
        assert_eq!(workspace_under(root, Path::new("/home/kd/plugin-workspaces/keepdeck.claude/ws-1/notes")).as_deref(), Some("ws-1"));
    }

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

    /// Two plugins' directories of ws-1 and ws-2, a third plugin's of ws-2
    /// alone — each handed out, so each is a write root.
    fn stand(root: &Path, grants: &PluginGrants) {
        for (plugin, ws) in [("keepdeck.claude", "ws-1"), ("keepdeck.claude", "ws-2"), ("keepdeck.opencode", "ws-1"), ("keepdeck.opencode", "ws-2"), ("keepdeck.kimi", "ws-2")] {
            let dir = dir_for(root, plugin, ws).unwrap();
            fs::write(dir.join("f"), "x").unwrap();
            grants.hand_workspace(plugin, ws, dir.to_string_lossy().into_owned());
        }
    }

    #[test]
    fn retain_drops_every_plugins_dir_of_a_departed_workspace_and_its_grant_and_keeps_the_live() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugin-workspaces");
        let grants = PluginGrants::default();
        stand(&root, &grants);
        retain(&PluginDirsLock::default(), &grants, &root, &["ws-1".to_string()]).unwrap();
        assert!(root.join("keepdeck.claude/ws-1/f").exists());
        assert!(root.join("keepdeck.opencode/ws-1/f").exists());
        assert!(!root.join("keepdeck.claude/ws-2").exists());
        assert!(!root.join("keepdeck.opencode/ws-2").exists());
        assert!(!root.join("keepdeck.kimi").exists(), "an emptied plugin folder goes too");
        assert_eq!(grants.write_roots("keepdeck.claude", |_| true).unwrap(), [dir_for(&root, "keepdeck.claude", "ws-1").unwrap().to_string_lossy()]);
        assert!(grants.write_roots("keepdeck.kimi", |_| true).is_err(), "no root left where nothing is left");
    }

    #[test]
    fn forgetting_a_workspace_takes_every_plugins_dir_of_it_and_no_other() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugin-workspaces");
        let grants = PluginGrants::default();
        stand(&root, &grants);
        forget(&PluginDirsLock::default(), &grants, &root, "ws-2").unwrap();
        assert!(root.join("keepdeck.claude/ws-1/f").exists() && root.join("keepdeck.opencode/ws-1/f").exists());
        assert!(!root.join("keepdeck.claude/ws-2").exists() && !root.join("keepdeck.kimi").exists());
        forget(&PluginDirsLock::default(), &grants, &root, "ws-2").expect("a repeat finds nothing to do");
        forget(&PluginDirsLock::default(), &grants, &tmp.path().join("absent"), "ws-1").expect("no folder at all");
    }

    #[test]
    fn a_forgotten_workspace_is_handed_no_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugin-workspaces");
        let grants = PluginGrants::default();
        let forget = crate::forgotten::testing::Forget::default();
        forget.forget("ws-gone");
        let lock = PluginDirsLock::default();
        assert!(hand_out(&lock, &grants, &forget.gate(), &root, "keepdeck.claude", "ws-gone").unwrap_err().contains("closed"));
        assert!(!root.exists(), "nothing made");
        assert!(grants.write_roots("keepdeck.claude", |_| true).is_err(), "nothing granted");
        let dir = hand_out(&lock, &grants, &forget.gate(), &root, "keepdeck.claude", "ws-1").unwrap();
        assert_eq!(grants.write_roots("keepdeck.claude", |_| true).unwrap(), [dir]);
    }
}
