//! One-time retirement of what builds before plugin API 73 planted and built
//! for particular CLIs themselves.
//!
//! Those builds planted in pane directories — a skills link and an MCP config
//! file, each recorded in an `armed/<wsId>` manifest of its feature — and kept
//! a config home per workspace for one CLI under the skills root. Planting is
//! now each agent's plugin's to declare and the cwd arming engine's to do
//! ([`crate::cwd_arm`]), and the config home is the plugin's own workspace
//! directory. So at startup, before the webview restores a single pane:
//!
//! - every recorded link that still points into the skills root, and every
//!   recorded config beside its `.keepdeck-managed` marker, is taken back —
//!   with the directory it leaves empty and the `info/exclude` line it was
//!   hidden by. A pane that still needs one gets it back from its plugin the
//!   moment it starts;
//! - what the CLI itself kept in its old config home (its own state, never
//!   KeepDeck's two subtrees) moves into the plugin's directory, where its
//!   new config home is, rather than being deleted.
//!
//! A manifest goes once everything it names was dealt with, so the pass is
//! done for good the first time it gets through; one that will not read is
//! kept and said, as evidence of plantings nothing else can find. Nothing
//! here is ever written for a new build — the whole module is deletable once
//! no install predates API 73.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;

use crate::worktree_arm::remove_excluded;

/// The marker older builds put beside a config they planted.
const MARKER_FILE: &str = ".keepdeck-managed";
/// The directory the skills link sat in, and the link itself.
const LINK_DIR: &str = ".agents";
const LINK: &str = "skills";
/// The directory the MCP config sat in, and the config itself.
const MCP_DIR: &str = ".kimi-code";
const MCP_FILE: &str = "mcp.json";
/// The per-workspace config homes under the skills root, and the plugin whose
/// workspace directory now holds that CLI's config home (`<dir>/config`).
const CONFIG_HOMES: &str = "opencode";
const CONFIG_HOME_PLUGIN: &str = "keepdeck.opencode";
/// KeepDeck's own subtrees in such a home: rebuilt by the plugin, not moved.
const CONFIG_HOME_OURS: [&str; 2] = ["skills", "command"];

/// Retire everything an older build left. Best-effort throughout: a failure
/// is logged and leaves its record for the next launch.
pub fn run() {
    let Some(home) = crate::paths::keepdeck_home() else { return };
    retire(&home);
}

fn retire(home: &Path) {
    let skills = home.join("skills");
    let link_target_root = skills.clone();
    sweep_manifests(&skills.join("armed"), |cwd| take_back_link(cwd, &link_target_root));
    sweep_manifests(&home.join("mcp").join("armed"), take_back_config);
    if let Err(e) = adopt_config_homes(&skills.join(CONFIG_HOMES), &home.join("plugin-workspaces")) {
        log::warn!("legacy plantings: moving the old config homes failed: {e}");
    }
}

/// Read each `<dir>/<wsId>` manifest (a JSON list of cwds), take its
/// plantings back, and drop it once every cwd went through.
fn sweep_manifests(dir: &Path, take_back: impl Fn(&Path) -> io::Result<()>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(cwds) = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        else {
            log::warn!("legacy plantings: {} is unreadable — kept", path.display());
            continue;
        };
        let mut done = true;
        for cwd in &cwds {
            if let Err(e) = take_back(Path::new(cwd)) {
                log::warn!("legacy plantings: taking back from {cwd} failed: {e}");
                done = false;
            }
        }
        if done {
            let _ = fs::remove_file(&path);
        }
    }
    let _ = fs::remove_dir(dir);
}

/// The skills link, while it still points into the skills root — anything
/// else at that path is the user's.
fn take_back_link(cwd: &Path, target_root: &Path) -> io::Result<()> {
    let link_dir = cwd.join(LINK_DIR);
    let link = link_dir.join(LINK);
    match fs::symlink_metadata(&link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if !fs::read_link(&link)?.starts_with(target_root) {
                return Ok(());
            }
            fs::remove_file(&link)?;
        }
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    release_dir(cwd, LINK_DIR)
}

/// The MCP config, while our marker stands beside it — without one it is the
/// user's.
fn take_back_config(cwd: &Path) -> io::Result<()> {
    let dir = cwd.join(MCP_DIR);
    let marker = dir.join(MARKER_FILE);
    if !marker.exists() {
        return Ok(());
    }
    for file in [dir.join(MCP_FILE), marker] {
        match fs::remove_file(file) {
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            other => other?,
        }
    }
    release_dir(cwd, MCP_DIR)
}

/// Remove `<cwd>/<name>` if we left it empty, and stop hiding it from git once
/// it is gone. A directory the CLI or the user keeps something in stays, and
/// so does its exclude line.
fn release_dir(cwd: &Path, name: &str) -> io::Result<()> {
    let _ = fs::remove_dir(cwd.join(name));
    if fs::symlink_metadata(cwd.join(name)).is_err() {
        remove_excluded(cwd, name)?;
    }
    Ok(())
}

/// Each workspace's old config home: KeepDeck's subtrees and build leftovers
/// go, and whatever the CLI kept there moves into the plugin's workspace
/// directory beside its new config — never over something already there.
fn adopt_config_homes(old: &Path, plugin_workspaces: &Path) -> io::Result<()> {
    let homes = match fs::read_dir(old) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for home in homes.flatten() {
        let ws_id = home.file_name().to_string_lossy().into_owned();
        let path = home.path();
        let adopted = crate::plugin_workspaces::dir_for(plugin_workspaces, CONFIG_HOME_PLUGIN, &ws_id)
            .map_err(io::Error::other)
            .and_then(|dir| adopt_one(&path, &dir.join("config")));
        if let Err(e) = adopted {
            log::warn!("legacy plantings: the config home of {ws_id} stays where it was: {e}");
        }
    }
    let _ = fs::remove_dir(old);
    Ok(())
}

fn adopt_one(home: &Path, config: &Path) -> io::Result<()> {
    for entry in fs::read_dir(home)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if name.starts_with('.') || CONFIG_HOME_OURS.contains(&name.as_str()) {
            remove_any(&path)?;
            continue;
        }
        let dest = config.join(&name);
        if fs::symlink_metadata(&dest).is_ok() {
            log::warn!("legacy plantings: {} already exists — {} stays", dest.display(), path.display());
            continue;
        }
        fs::create_dir_all(config)?;
        fs::rename(&path, &dest)?;
    }
    let _ = fs::remove_dir(home);
    Ok(())
}

fn remove_any(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree_arm::test_support::fake_worktree;
    use std::path::PathBuf;

    fn manifest(dir: &Path, ws: &str, cwds: &[&Path]) {
        fs::create_dir_all(dir).unwrap();
        let cwds: Vec<String> = cwds.iter().map(|c| c.to_string_lossy().into_owned()).collect();
        fs::write(dir.join(ws), serde_json::to_vec(&cwds).unwrap()).unwrap();
    }

    fn exclude_of(base: &Path) -> String {
        fs::read_to_string(base.join("main").join(".git").join("info").join("exclude")).unwrap_or_default()
    }

    fn link(target: &Path, at: &Path) {
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(target, at).unwrap();
    }

    struct Scratch {
        _tmp: tempfile::TempDir,
        base: PathBuf,
        home: PathBuf,
    }

    fn scratch() -> Scratch {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        let home = base.join("home");
        fs::create_dir_all(&home).unwrap();
        Scratch { _tmp: tmp, base, home }
    }

    #[test]
    fn takes_back_an_old_link_with_its_dir_and_exclude_line_and_drops_the_manifest() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        let staged = s.home.join("skills").join("staging").join("ws-1").join("skills");
        fs::create_dir_all(&staged).unwrap();
        link(&staged, &wt.join(LINK_DIR).join(LINK));
        crate::worktree_arm::ensure_excluded(&wt, LINK_DIR).unwrap();
        manifest(&s.home.join("skills").join("armed"), "ws-1", &[&wt]);

        retire(&s.home);

        assert!(fs::symlink_metadata(wt.join(LINK_DIR)).is_err());
        assert!(!exclude_of(&s.base).contains(&format!("/{LINK_DIR}/")));
        assert!(!s.home.join("skills").join("armed").exists());
        // The staging itself is the skills feature's, not this pass's.
        assert!(staged.exists());
    }

    #[test]
    fn leaves_a_link_pointing_elsewhere_and_whatever_shares_its_dir() {
        let s = scratch();
        let cwd = s.base.join("repo");
        let theirs = s.base.join("their-skills");
        fs::create_dir_all(&theirs).unwrap();
        link(&theirs, &cwd.join(LINK_DIR).join(LINK));
        fs::write(cwd.join(LINK_DIR).join("notes"), "mine").unwrap();
        manifest(&s.home.join("skills").join("armed"), "ws-1", &[&cwd]);

        retire(&s.home);

        assert_eq!(fs::read_link(cwd.join(LINK_DIR).join(LINK)).unwrap(), theirs);
        assert!(cwd.join(LINK_DIR).join("notes").exists());
    }

    #[test]
    fn takes_back_an_old_config_beside_its_marker_and_spares_one_without() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        let ours = wt.join(MCP_DIR);
        fs::create_dir_all(&ours).unwrap();
        fs::write(ours.join(MCP_FILE), "{}").unwrap();
        fs::write(ours.join(MARKER_FILE), "").unwrap();
        crate::worktree_arm::ensure_excluded(&wt, MCP_DIR).unwrap();
        let users = s.base.join("users-repo");
        fs::create_dir_all(users.join(MCP_DIR)).unwrap();
        fs::write(users.join(MCP_DIR).join(MCP_FILE), "their own").unwrap();
        manifest(&s.home.join("mcp").join("armed"), "ws-1", &[&wt, &users]);

        retire(&s.home);

        assert!(!ours.exists());
        assert!(!exclude_of(&s.base).contains(&format!("/{MCP_DIR}/")));
        assert_eq!(fs::read_to_string(users.join(MCP_DIR).join(MCP_FILE)).unwrap(), "their own");
        assert!(!s.home.join("mcp").join("armed").exists());
    }

    #[test]
    fn a_config_dir_the_cli_keeps_state_in_stays_with_its_exclude_line() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        let dir = wt.join(MCP_DIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MCP_FILE), "{}").unwrap();
        fs::write(dir.join(MARKER_FILE), "").unwrap();
        fs::write(dir.join("state.db"), "cli's").unwrap();
        crate::worktree_arm::ensure_excluded(&wt, MCP_DIR).unwrap();
        manifest(&s.home.join("mcp").join("armed"), "ws-1", &[&wt]);

        retire(&s.home);

        assert!(!dir.join(MCP_FILE).exists());
        assert!(dir.join("state.db").exists());
        assert!(exclude_of(&s.base).contains(&format!("/{MCP_DIR}/")));
    }

    #[test]
    fn an_unreadable_manifest_is_kept() {
        let s = scratch();
        let armed = s.home.join("mcp").join("armed");
        fs::create_dir_all(&armed).unwrap();
        fs::write(armed.join("ws-1"), "not json").unwrap();

        retire(&s.home);

        assert!(armed.join("ws-1").exists());
    }

    #[test]
    fn moves_what_the_cli_kept_in_its_old_config_home_and_drops_ours() {
        let s = scratch();
        let old = s.home.join("skills").join(CONFIG_HOMES).join("ws-1");
        for ours in CONFIG_HOME_OURS {
            fs::create_dir_all(old.join(ours).join("review")).unwrap();
        }
        fs::create_dir_all(old.join(".old-skills")).unwrap();
        fs::write(old.join("accounts.json"), "precious").unwrap();
        fs::create_dir_all(old.join("node_modules").join("dep")).unwrap();

        retire(&s.home);

        let config = s.home.join("plugin-workspaces").join(CONFIG_HOME_PLUGIN).join("ws-1").join("config");
        assert_eq!(fs::read_to_string(config.join("accounts.json")).unwrap(), "precious");
        assert!(config.join("node_modules").join("dep").exists());
        for ours in CONFIG_HOME_OURS {
            assert!(!config.join(ours).exists(), "{ours} is rebuilt by the plugin, not moved");
        }
        assert!(!s.home.join("skills").join(CONFIG_HOMES).exists());
    }

    #[test]
    fn never_moves_over_what_the_new_config_home_already_has() {
        let s = scratch();
        let old = s.home.join("skills").join(CONFIG_HOMES).join("ws-1");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("accounts.json"), "old").unwrap();
        let config = s.home.join("plugin-workspaces").join(CONFIG_HOME_PLUGIN).join("ws-1").join("config");
        fs::create_dir_all(&config).unwrap();
        fs::write(config.join("accounts.json"), "new").unwrap();

        retire(&s.home);

        assert_eq!(fs::read_to_string(config.join("accounts.json")).unwrap(), "new");
        assert_eq!(fs::read_to_string(old.join("accounts.json")).unwrap(), "old");
    }

    #[test]
    fn a_home_with_nothing_old_is_left_as_it_is() {
        let s = scratch();
        retire(&s.home);
        assert_eq!(fs::read_dir(&s.home).unwrap().count(), 0);
    }
}
