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
//! - every recorded link that is still exactly the one those builds made — to
//!   a staging view, `<skills>/staging/<ws>/skills`, in plain names — and
//!   every recorded config beside its `.keepdeck-managed` marker, is taken
//!   back with the directory it leaves empty. A pane that still needs one gets
//!   it back from its plugin the moment it starts. Whatever the arming engine
//!   records at the same place is the new build's: it stays, and the old
//!   record of it simply goes;
//! - the exclude lines those builds added carried no mark, so nothing can tell
//!   one from the same line the user wrote: they stay;
//! - the old config homes are deleted. The CLI's login lives elsewhere; what
//!   it kept there (its plugins' state, its install tree) is rebuilt in the
//!   plugin's own directory — a re-login for a plugin that needs one, as
//!   decided when API 73 was planned.
//!
//! A manifest is rewritten with only the cwds that failed, and goes once none
//! is left, so the pass is done for good the first time it gets through and
//! never comes back for a cwd it already finished; one that will not read is
//! kept and said, as evidence of plantings nothing else can find. Nothing
//! here is ever written for a new build — the whole module is deletable once
//! no install predates API 73.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Component, Path};

use crate::state::write_atomic;

/// The marker older builds put beside a config they planted.
const MARKER_FILE: &str = ".keepdeck-managed";
/// The directory the skills link sat in, and the link itself.
const LINK_DIR: &str = ".agents";
const LINK: &str = "skills";
/// The directory the MCP config sat in, and the config itself.
const MCP_DIR: &str = ".kimi-code";
const MCP_FILE: &str = "mcp.json";
/// The per-workspace config homes older builds kept under the skills root.
const CONFIG_HOMES: &str = "opencode";

/// Retire everything an older build left. Best-effort throughout: a failure
/// is logged and leaves its record for the next launch.
pub fn run() {
    let Some(home) = crate::paths::keepdeck_home() else { return };
    retire(&home);
}

fn retire(home: &Path) {
    let skills = home.join("skills");
    let arms = crate::cwd_arm::records_root(home);
    sweep_manifests(&skills.join("armed"), |cwd| take_back_link(cwd, &skills, &arms));
    sweep_manifests(&home.join("mcp").join("armed"), |cwd| take_back_config(cwd, &arms));
    match fs::remove_dir_all(skills.join(CONFIG_HOMES)) {
        Err(e) if e.kind() != ErrorKind::NotFound => {
            log::warn!("legacy plantings: deleting the old config homes failed, retried next launch: {e}");
        }
        _ => {}
    }
}

/// Read each `<dir>/<wsId>` manifest (a JSON list of cwds) and take its
/// plantings back; what is left is only the cwds that failed.
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
        let failed: Vec<&String> = cwds
            .iter()
            .filter(|cwd| match take_back(Path::new(cwd)) {
                Ok(()) => false,
                Err(e) => {
                    log::warn!("legacy plantings: taking back from {cwd} failed: {e}");
                    true
                }
            })
            .collect();
        let left = if failed.is_empty() {
            fs::remove_file(&path)
        } else if failed.len() < cwds.len() {
            serde_json::to_vec(&failed).map_err(io::Error::other).and_then(|bytes| write_atomic(&path, &bytes))
        } else {
            Ok(())
        };
        if let Err(e) = left {
            log::warn!("legacy plantings: updating {} failed: {e}", path.display());
        }
    }
    let _ = fs::remove_dir(dir);
}

/// The skills link, while it is still the one an older build made and the
/// arming engine records nothing there — anything else at that path is the
/// user's, or the new build's.
fn take_back_link(cwd: &Path, skills_root: &Path, arms: &Path) -> io::Result<()> {
    let link = cwd.join(LINK_DIR).join(LINK);
    match fs::symlink_metadata(&link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if !made_by_older_build(&fs::read_link(&link)?, skills_root)
                || crate::cwd_arm::recorded_at(arms, cwd, &format!("{LINK_DIR}/{LINK}"))?
            {
                return Ok(());
            }
            fs::remove_file(&link)?;
        }
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let _ = fs::remove_dir(cwd.join(LINK_DIR));
    Ok(())
}

/// The one link an older build made: `<skills>/staging/<ws>/skills`, spelled
/// in plain names only. Judged on the text, never resolved — a spelling with
/// `..` that merely starts like the skills root may lead anywhere.
fn made_by_older_build(target: &Path, skills_root: &Path) -> bool {
    let Ok(rest) = target.strip_prefix(skills_root) else { return false };
    let parts: Vec<Component> = rest.components().collect();
    matches!(
        parts.as_slice(),
        [Component::Normal(staging), Component::Normal(_), Component::Normal(skills)]
            if *staging == "staging" && *skills == LINK
    )
}

/// The MCP config, while our marker stands beside it and the arming engine
/// records nothing there — without a marker it is the user's.
fn take_back_config(cwd: &Path, arms: &Path) -> io::Result<()> {
    let dir = cwd.join(MCP_DIR);
    let marker = dir.join(MARKER_FILE);
    if !marker.exists() || crate::cwd_arm::recorded_at(arms, cwd, &format!("{MCP_DIR}/{MCP_FILE}"))? {
        return Ok(());
    }
    for file in [dir.join(MCP_FILE), marker] {
        match fs::remove_file(file) {
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            other => other?,
        }
    }
    let _ = fs::remove_dir(&dir);
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::worktree_arm::test_support::fake_worktree;
    use std::path::PathBuf;

    fn manifest(dir: &Path, ws: &str, cwds: &[&Path]) {
        fs::create_dir_all(dir).unwrap();
        let cwds: Vec<String> = cwds.iter().map(|c| c.to_string_lossy().into_owned()).collect();
        fs::write(dir.join(ws), serde_json::to_vec(&cwds).unwrap()).unwrap();
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
        let base = fs::canonicalize(tmp.path()).unwrap();
        let home = base.join("home");
        fs::create_dir_all(&home).unwrap();
        Scratch { _tmp: tmp, base, home }
    }

    impl Scratch {
        fn staged(&self) -> PathBuf {
            let staged = self.home.join("skills/staging/ws-1/skills");
            fs::create_dir_all(&staged).unwrap();
            staged
        }
        fn exclude(&self) -> PathBuf {
            self.base.join("main/.git/info/exclude")
        }
    }

    #[test]
    fn takes_back_an_old_link_with_its_dir_and_drops_the_manifest() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        let staged = s.staged();
        link(&staged, &wt.join(LINK_DIR).join(LINK));
        manifest(&s.home.join("skills/armed"), "ws-1", &[&wt]);

        retire(&s.home);

        assert!(fs::symlink_metadata(wt.join(LINK_DIR)).is_err());
        assert!(!s.home.join("skills/armed").exists());
        // The staging itself is the skills feature's, not this pass's.
        assert!(staged.exists());
    }

    #[test]
    fn an_old_builds_unmarked_exclude_line_stays_it_could_be_the_users() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        link(&s.staged(), &wt.join(LINK_DIR).join(LINK));
        fs::create_dir_all(s.exclude().parent().unwrap()).unwrap();
        fs::write(s.exclude(), "/.agents/\n").unwrap();
        manifest(&s.home.join("skills/armed"), "ws-1", &[&wt]);

        retire(&s.home);

        assert_eq!(fs::read_to_string(s.exclude()).unwrap(), "/.agents/\n");
    }

    #[test]
    fn leaves_a_link_pointing_elsewhere_and_whatever_shares_its_dir() {
        let s = scratch();
        let cwd = s.base.join("repo");
        let theirs = s.base.join("their-skills");
        fs::create_dir_all(&theirs).unwrap();
        link(&theirs, &cwd.join(LINK_DIR).join(LINK));
        fs::write(cwd.join(LINK_DIR).join("notes"), "mine").unwrap();
        manifest(&s.home.join("skills/armed"), "ws-1", &[&cwd]);

        retire(&s.home);

        assert_eq!(fs::read_link(cwd.join(LINK_DIR).join(LINK)).unwrap(), theirs);
        assert!(cwd.join(LINK_DIR).join("notes").exists());
    }

    #[test]
    fn a_link_that_only_reads_as_inside_the_skills_root_is_the_users() {
        let s = scratch();
        let theirs = s.base.join("theirs");
        fs::create_dir_all(&theirs).unwrap();
        let cwd = s.base.join("repo");
        // Starts with the skills root, leads outside it — and into the root
        // itself, or its library: neither is a link an older build made.
        for target in [
            s.home.join("skills/../../theirs"),
            s.home.join("skills/library/ws-1"),
            s.home.join("skills"),
        ] {
            link(&target, &cwd.join(LINK_DIR).join(LINK));
            manifest(&s.home.join("skills/armed"), "ws-1", &[&cwd]);
            retire(&s.home);
            assert_eq!(fs::read_link(cwd.join(LINK_DIR).join(LINK)).unwrap(), target);
            fs::remove_file(cwd.join(LINK_DIR).join(LINK)).unwrap();
        }
    }

    #[test]
    fn what_the_arming_engine_planted_at_the_same_place_stays() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        let staged = s.staged();
        let arms = crate::cwd_arm::records_root(&s.home);
        fs::create_dir_all(&arms).unwrap();
        let records = serde_json::json!([
            { "cwd": wt, "plugin": "p.linker", "path": ".agents/skills", "kind": "symlink", "target": staged },
            { "cwd": wt, "plugin": "p.filer", "path": ".kimi-code/mcp.json", "kind": "file" },
        ]);
        fs::write(arms.join("ws-2.json"), records.to_string()).unwrap();
        link(&staged, &wt.join(LINK_DIR).join(LINK));
        fs::create_dir_all(wt.join(MCP_DIR)).unwrap();
        fs::write(wt.join(MCP_DIR).join(MCP_FILE), "{}").unwrap();
        fs::write(wt.join(MCP_DIR).join(MARKER_FILE), "").unwrap();
        manifest(&s.home.join("skills/armed"), "ws-1", &[&wt]);
        manifest(&s.home.join("mcp/armed"), "ws-1", &[&wt]);

        retire(&s.home);

        assert_eq!(fs::read_link(wt.join(LINK_DIR).join(LINK)).unwrap(), staged);
        assert!(wt.join(MCP_DIR).join(MCP_FILE).exists());
        assert!(!s.home.join("skills/armed").exists(), "the old record of it goes");
        assert!(!s.home.join("mcp/armed").exists());
    }

    #[test]
    fn an_unreadable_arming_record_keeps_the_old_planting_and_its_manifest() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        link(&s.staged(), &wt.join(LINK_DIR).join(LINK));
        let arms = crate::cwd_arm::records_root(&s.home);
        fs::create_dir_all(&arms).unwrap();
        fs::write(arms.join("ws-2.json"), "not json").unwrap();
        manifest(&s.home.join("skills/armed"), "ws-1", &[&wt]);

        retire(&s.home);

        assert!(fs::symlink_metadata(wt.join(LINK_DIR).join(LINK)).is_ok());
        assert!(s.home.join("skills/armed/ws-1").exists());
    }

    #[test]
    fn a_manifest_keeps_only_the_cwds_that_failed() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        let ours = wt.join(MCP_DIR);
        fs::create_dir_all(&ours).unwrap();
        fs::write(ours.join(MCP_FILE), "{}").unwrap();
        fs::write(ours.join(MARKER_FILE), "").unwrap();
        // A cwd whose marker cannot be judged: its directory is unreadable.
        let stuck = s.base.join("stuck");
        fs::create_dir_all(stuck.join(MCP_DIR)).unwrap();
        fs::write(stuck.join(MCP_DIR).join(MARKER_FILE), "").unwrap();
        fs::write(stuck.join(MCP_DIR).join(MCP_FILE), "{}").unwrap();
        let armed = s.home.join("mcp/armed");
        manifest(&armed, "ws-1", &[&wt, &stuck]);
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(stuck.join(MCP_DIR), fs::Permissions::from_mode(0o500)).unwrap();

        retire(&s.home);

        fs::set_permissions(stuck.join(MCP_DIR), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(!ours.exists());
        let left: Vec<String> = serde_json::from_slice(&fs::read(armed.join("ws-1")).unwrap()).unwrap();
        assert_eq!(left, vec![stuck.to_string_lossy().into_owned()]);
    }

    #[test]
    fn takes_back_an_old_config_beside_its_marker_and_spares_one_without() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        let ours = wt.join(MCP_DIR);
        fs::create_dir_all(&ours).unwrap();
        fs::write(ours.join(MCP_FILE), "{}").unwrap();
        fs::write(ours.join(MARKER_FILE), "").unwrap();
        let users = s.base.join("users-repo");
        fs::create_dir_all(users.join(MCP_DIR)).unwrap();
        fs::write(users.join(MCP_DIR).join(MCP_FILE), "their own").unwrap();
        manifest(&s.home.join("mcp/armed"), "ws-1", &[&wt, &users]);

        retire(&s.home);

        assert!(!ours.exists());
        assert_eq!(fs::read_to_string(users.join(MCP_DIR).join(MCP_FILE)).unwrap(), "their own");
        assert!(!s.home.join("mcp/armed").exists());
    }

    #[test]
    fn a_config_dir_the_cli_keeps_state_in_stays() {
        let s = scratch();
        let wt = fake_worktree(&s.base);
        let dir = wt.join(MCP_DIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MCP_FILE), "{}").unwrap();
        fs::write(dir.join(MARKER_FILE), "").unwrap();
        fs::write(dir.join("state.db"), "cli's").unwrap();
        manifest(&s.home.join("mcp/armed"), "ws-1", &[&wt]);

        retire(&s.home);

        assert!(!dir.join(MCP_FILE).exists());
        assert!(dir.join("state.db").exists());
    }

    #[test]
    fn an_unreadable_manifest_is_kept() {
        let s = scratch();
        let armed = s.home.join("mcp/armed");
        fs::create_dir_all(&armed).unwrap();
        fs::write(armed.join("ws-1"), "not json").unwrap();

        retire(&s.home);

        assert!(armed.join("ws-1").exists());
    }

    #[test]
    fn the_old_config_homes_are_deleted_and_nothing_is_built_in_their_place() {
        let s = scratch();
        let old = s.home.join("skills").join(CONFIG_HOMES).join("ws-1");
        fs::create_dir_all(old.join("skills/review")).unwrap();
        fs::create_dir_all(old.join("node_modules/dep")).unwrap();
        fs::write(old.join(".state"), "x").unwrap();

        retire(&s.home);

        assert!(!s.home.join("skills").join(CONFIG_HOMES).exists());
        assert!(!s.home.join("plugin-workspaces").exists());
    }

    #[test]
    fn a_home_with_nothing_old_is_left_as_it_is() {
        let s = scratch();
        retire(&s.home);
        assert_eq!(fs::read_dir(&s.home).unwrap().count(), 0);
    }
}
