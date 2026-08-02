//! Per-workspace staging: the derived views a spawning CLI is pointed at.
//!
//! A staging is global + workspace skills merged (a workspace skill wins a
//! name clash) and rebuilt from scratch on every request, so a view can never
//! serve a deleted or stale skill:
//!
//! - `staging/<wsId>/claude-plugin/` — a Claude Code plugin dir
//!   (`.claude-plugin/plugin.json` + `skills/`) for `--plugin-dir`
//! - `staging/<wsId>/skills/` — the bare standard layout (`<skill>/SKILL.md`
//!   at top level) for kimi's `--skills-dir`; the same shape codex reads
//!   through the arming symlink ([`super::arming`])
//! - `opencode/<wsId>/` — an OpenCode config dir for `OPENCODE_CONFIG_DIR`,
//!   carrying each skill twice: under `skills/` for the model's own `skill`
//!   tool, and as a generated `command/<name>.md` ([`super::opencode`]) so the
//!   skill is USER-visible too. STABLE, not under `staging/`: opencode treats
//!   the directory as a writable config home (it installs plugin
//!   node_modules and drops account/state files there — field-verified on
//!   1.18.3), so only the `skills/` and `command/` subtrees are KeepDeck's to
//!   replace; everything else in it must survive every rebuild.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use super::arming::{arm_roots, disarm_roots};
use crate::worktree_arm::{record_armed, retire_key};
use super::library::{sorted_dirs, SKILL_FILE};
use super::{opencode, SkillStagingDto, SkillsLocks};
use crate::state::write_atomic;

/// The Claude-plugin wrapper manifest a staged `--plugin-dir` needs. The
/// plugin name prefixes skill invocations (`keepdeck-skills:<name>`), so it
/// stays stable — renaming it would rename every staged skill.
const CLAUDE_PLUGIN_MANIFEST: &str = concat!(
    r#"{"name": "keepdeck-skills", "#,
    r#""description": "Skills shared through KeepDeck", "#,
    r#""version": "0.1.0"}"#,
);

pub(crate) fn stage(
    locks: &SkillsLocks,
    root: &Path,
    ws_id: &str,
    spawn_roots: &[String],
) -> io::Result<Option<SkillStagingDto>> {
    let library = root.join("library");
    let final_dir = root.join("staging").join(ws_id);
    // opencode's view lives OUTSIDE the wiped staging: opencode writes its
    // own files into its config dir, and those must survive every rebuild —
    // only the `skills/` subtree below this dir is KeepDeck's.
    let opencode_dir = root.join("opencode").join(ws_id);

    // Overlapping same-ws stagings share tmp dirs and the swap — serialize.
    let lock = locks.for_ws(ws_id);
    let _staging = lock.lock().unwrap_or_else(|p| p.into_inner());

    let sources = collect_sources(&library, ws_id);

    if sources.is_empty() {
        // An emptied library must not leave yesterday's views behind — but
        // opencode's own files next to our subtrees are not ours to touch.
        for stale in [
            final_dir,
            opencode_dir.join("skills"),
            opencode_dir.join("command"),
        ] {
            match fs::remove_dir_all(&stale) {
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                other => other?,
            }
        }
        // Disarm everything this workspace ever armed, not only the cwds
        // still in spawn_roots (a closed pane's cwd would otherwise dangle)
        // — sparing any cwd another workspace still claims.
        retire_key(root, ws_id, spawn_roots, |roots| disarm_roots(root, roots))?;
        return Ok(None);
    }

    // Build aside, then swap: a pane spawning mid-rebuild reads either the
    // old complete view or the new one, never a half-copied one.
    let tmp = root.join("staging").join(format!(".tmp-{ws_id}"));
    match fs::remove_dir_all(&tmp) {
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        other => other?,
    }
    let claude_plugin = tmp.join("claude-plugin");
    write_atomic(
        &claude_plugin.join(".claude-plugin").join("plugin.json"),
        CLAUDE_PLUGIN_MANIFEST.as_bytes(),
    )?;
    let opencode_tmp = opencode_dir.join(".skills-tmp");
    let opencode_cmd_tmp = opencode_dir.join(".command-tmp");
    for stale in [&opencode_tmp, &opencode_cmd_tmp] {
        match fs::remove_dir_all(stale) {
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            other => other?,
        }
    }
    for (name, source, content) in &sources {
        // A source deleted between collection and here is SKIPPED outright —
        // re-materializing it from the collected bytes would resurrect a
        // deleted skill for one stage. Views copied BEFORE the vanish are
        // wiped too, so no view carries the ghost the later ones dropped.
        let views = [
            claude_plugin.join("skills"),
            tmp.join("skills"),
            opencode_tmp.clone(),
        ];
        let mut present = true;
        for view in &views {
            let dest = view.join(name);
            if !copy_dir(source, &dest)? {
                present = false;
                break;
            }
            // The staged SKILL.md is written from the content read at
            // collection time — the same bytes the generated command's
            // description came from. A save racing this loop can no longer
            // make the staged file and its command diverge.
            write_atomic(&dest.join(SKILL_FILE), content.as_bytes())?;
        }
        if !present {
            for view in &views {
                let _ = fs::remove_dir_all(view.join(name));
            }
            continue;
        }
        // The user-facing half of the opencode view: a /name command whose
        // palette description is the skill's own, pointing the agent at the
        // staged SKILL.md (the command file must not go stale on edits, so
        // it references rather than inlines).
        let staged_skill = opencode_dir.join("skills").join(name).join(SKILL_FILE);
        let command = opencode::command(name, content, &staged_skill);
        write_atomic(
            &opencode_cmd_tmp.join(format!("{name}.md")),
            command.as_bytes(),
        )?;
    }
    fs::create_dir_all(final_dir.parent().unwrap_or(root))?;
    swap_dir(&tmp, &final_dir, &root.join("staging").join(format!(".old-{ws_id}")))?;
    swap_dir(
        &opencode_tmp,
        &opencode_dir.join("skills"),
        &opencode_dir.join(".old-skills"),
    )?;
    swap_dir(
        &opencode_cmd_tmp,
        &opencode_dir.join("command"),
        &opencode_dir.join(".old-command"),
    )?;

    let armed = arm_roots(root, &final_dir.join("skills"), spawn_roots);
    record_armed(root, ws_id, &armed, "skills");

    let abs = |dir: &Path| dir.to_string_lossy().into_owned();
    Ok(Some(SkillStagingDto {
        claude_plugin_dir: abs(&final_dir.join("claude-plugin")),
        opencode_config_dir: abs(&opencode_dir),
        skills_dir: abs(&final_dir.join("skills")),
    }))
}

/// The workspace's effective skills — global first, workspace overrides by
/// name — with each SKILL.md's content read up front. A skill whose file
/// cannot be read (non-UTF-8, permissions) is SKIPPED with a warning, the
/// same treatment `list()` gives it: one broken skill must not take the
/// whole workspace's staging down.
fn collect_sources(library: &Path, ws_id: &str) -> Vec<(String, PathBuf, String)> {
    let mut sources: Vec<(String, PathBuf, String)> = Vec::new();
    for scope in [library.join("global"), library.join("ws").join(ws_id)] {
        let Ok(dirs) = sorted_dirs(&scope) else { continue };
        for skill in dirs {
            let content = match fs::read_to_string(skill.join(SKILL_FILE)) {
                Ok(content) => content,
                Err(e) if e.kind() == ErrorKind::NotFound => continue,
                Err(e) => {
                    log::warn!(
                        "skills: {} has an unreadable SKILL.md — skipped: {e}",
                        skill.display(),
                    );
                    continue;
                }
            };
            let name = skill.file_name().unwrap_or_default().to_string_lossy().into_owned();
            sources.retain(|(existing, _, _)| *existing != name);
            sources.push((name, skill, content));
        }
    }
    sources
}

/// Publish `tmp` at `final_dir` with the smallest possible outage: the old
/// dir is renamed aside (one syscall) rather than deleted in place, so a
/// reader — the persistent codex symlink, a live OPENCODE_CONFIG_DIR — sees
/// the target missing only between two renames, not for a whole recursive
/// delete.
fn swap_dir(tmp: &Path, final_dir: &Path, trash: &Path) -> io::Result<()> {
    let _ = fs::remove_dir_all(trash);
    match fs::rename(final_dir, trash) {
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        other => other?,
    }
    fs::rename(tmp, final_dir)?;
    let _ = fs::remove_dir_all(trash);
    Ok(())
}

/// Copy a skill directory tree (assets included); `Ok(false)` = the whole
/// source vanished mid-stage (a racing delete) and nothing was copied.
/// Symlinks are followed — the library is KeepDeck-authored, a link is the
/// author's own doing. `write_atomic`'s transient `SKILL.md.tmp` sibling is
/// excluded, and an entry that vanishes mid-copy (that same transient being
/// renamed away by a concurrent save) is skipped rather than failing the
/// whole stage.
fn copy_dir(from: &Path, to: &Path) -> io::Result<bool> {
    fs::create_dir_all(to)?;
    let entries = match fs::read_dir(from) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == "SKILL.md.tmp" {
            continue;
        }
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            let _ = copy_dir(&entry.path(), &target)?;
        } else {
            match fs::copy(entry.path(), &target) {
                Err(e) if e.kind() == ErrorKind::NotFound => continue,
                other => {
                    other?;
                }
            }
        }
    }
    Ok(true)
}

/// Drop the DERIVED per-workspace dirs (staging views, opencode config
/// homes) of workspaces that no longer exist. `.tmp-<id>`/`.old-<id>` build
/// leftovers follow the same liveness rule as the dirs themselves, so an
/// in-flight stage of a LIVE workspace can never lose its build-aside dir to
/// a concurrent prune. The library is user content and is never touched.
pub(crate) fn prune_views(root: &Path, live: &[String]) -> io::Result<()> {
    for parent in [root.join("staging"), root.join("opencode")] {
        for dir in sorted_dirs(&parent)? {
            let name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let id = name
                .strip_prefix(".tmp-")
                .or_else(|| name.strip_prefix(".old-"))
                .unwrap_or(&name);
            if live.iter().any(|l| l == id) {
                continue;
            }
            // Best-effort per dir: one stubborn/racing directory must not
            // abort the sweep before the manifest disarms run.
            if let Err(e) = fs::remove_dir_all(&dir) {
                log::warn!("skills: pruning {} failed: {e}", dir.display());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::library::{delete, list, save};
    use crate::skills::test_support::{fake_worktree, global, root, ws};

    #[test]
    fn stage_builds_all_three_views_with_workspace_override() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "global review").unwrap();
        save(&global(&root), "deploy", "deploy").unwrap();
        save(&ws(&root, "ws-1"), "review", "ws review").unwrap();
        // An asset rides along with its skill.
        fs::write(global(&root).join("deploy").join("notes.txt"), "asset").unwrap();

        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap().unwrap();
        let claude = PathBuf::from(&views.claude_plugin_dir);
        let manifest = fs::read_to_string(claude.join(".claude-plugin").join("plugin.json")).unwrap();
        assert!(manifest.contains("keepdeck-skills"));

        for skills in [
            claude.join("skills"),
            PathBuf::from(&views.opencode_config_dir).join("skills"),
            PathBuf::from(&views.skills_dir),
        ] {
            let review = fs::read_to_string(skills.join("review").join(SKILL_FILE)).unwrap();
            assert_eq!(review, "ws review"); // workspace wins the clash
            assert_eq!(
                fs::read_to_string(skills.join("deploy").join("notes.txt")).unwrap(),
                "asset",
            );
        }
    }

    #[test]
    fn every_skill_doubles_as_an_opencode_palette_command() {
        let (_tmp, root) = root();
        let content = "---\nname: review\ndescription: \"Reviews: the diff\"\n---\nBody\n";
        save(&global(&root), "review", content).unwrap();
        save(&ws(&root, "ws-1"), "review", "---\ndescription: Ws wins\n---\nB\n").unwrap();

        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap().unwrap();
        let oc = PathBuf::from(&views.opencode_config_dir);
        let command = fs::read_to_string(oc.join("command").join("review.md")).unwrap();
        // The palette description is the WINNING skill's, quoted verbatim,
        // and the body points at the staged SKILL.md.
        assert!(command.starts_with("---\ndescription: Ws wins\n---\n"));
        assert!(command.contains(
            oc.join("skills").join("review").join(SKILL_FILE).to_str().unwrap(),
        ));
    }

    #[test]
    fn opencodes_own_files_survive_restaging_and_emptying() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "x").unwrap();
        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap().unwrap();

        // opencode treats its config dir as writable (node_modules, account
        // files) — plant a stand-in next to the skills subtree.
        let oc = PathBuf::from(&views.opencode_config_dir);
        fs::write(oc.join("antigravity-accounts.json"), "precious").unwrap();

        save(&global(&root), "deploy", "y").unwrap();
        stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap().unwrap();
        assert_eq!(
            fs::read_to_string(oc.join("antigravity-accounts.json")).unwrap(),
            "precious",
        );
        assert!(oc.join("skills").join("deploy").exists());

        // An emptied library removes ONLY KeepDeck's subtrees.
        delete(&global(&root), "review").unwrap();
        delete(&global(&root), "deploy").unwrap();
        assert_eq!(stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap(), None);
        assert!(!oc.join("skills").exists());
        assert!(!oc.join("command").exists());
        assert_eq!(
            fs::read_to_string(oc.join("antigravity-accounts.json")).unwrap(),
            "precious",
        );
    }

    #[test]
    fn restaging_drops_deleted_skills() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "x").unwrap();
        save(&global(&root), "deploy", "x").unwrap();
        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap().unwrap();

        delete(&global(&root), "deploy").unwrap();
        stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap().unwrap();
        let skills = PathBuf::from(&views.skills_dir);
        assert!(skills.join("review").exists());
        assert!(!skills.join("deploy").exists());
    }

    #[test]
    fn empty_library_stages_nothing_and_clears_stale_views() {
        let (_tmp, root) = root();
        assert_eq!(stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap(), None);

        save(&ws(&root, "ws-1"), "review", "x").unwrap();
        stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap().unwrap();
        delete(&ws(&root, "ws-1"), "review").unwrap();
        assert_eq!(stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap(), None);
        assert!(!root.join("staging").join("ws-1").exists());
    }

    #[test]
    fn staging_arms_a_worktree_with_an_owned_symlink_and_excludes_it() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        save(&global(&root), "review", "x").unwrap();

        let roots = vec![wt.to_string_lossy().into_owned()];
        let views = stage(&SkillsLocks::default(), &root, "ws-1", &roots).unwrap().unwrap();

        let link = wt.join(".agents").join("skills");
        assert_eq!(
            fs::read_link(&link).unwrap(),
            PathBuf::from(&views.skills_dir),
        );
        // The skill is reachable THROUGH the link, as codex would read it.
        assert!(link.join("review").join(SKILL_FILE).exists());

        // The exclude line lands in the COMMON git dir, exactly once even
        // after restaging.
        stage(&SkillsLocks::default(), &root, "ws-1", &roots).unwrap().unwrap();
        let exclude = root
            .parent()
            .unwrap()
            .join("main")
            .join(".git")
            .join("info")
            .join("exclude");
        let text = fs::read_to_string(exclude).unwrap();
        assert_eq!(text.matches("/.agents/").count(), 1);
    }

    #[test]
    fn emptied_library_disarms_and_removes_an_empty_agents_dir() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        save(&global(&root), "review", "x").unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];
        stage(&SkillsLocks::default(), &root, "ws-1", &roots).unwrap().unwrap();

        delete(&global(&root), "review").unwrap();
        assert_eq!(stage(&SkillsLocks::default(), &root, "ws-1", &roots).unwrap(), None);
        assert!(!wt.join(".agents").exists());
    }

    #[test]
    fn emptying_the_library_disarms_cwds_that_left_the_spawn_roots() {
        let (_tmp, root) = root();
        let gone = root.parent().unwrap().join("closed-pane-cwd");
        let kept = root.parent().unwrap().join("open-pane-cwd");
        fs::create_dir_all(&gone).unwrap();
        fs::create_dir_all(&kept).unwrap();
        save(&global(&root), "review", "x").unwrap();
        let locks = SkillsLocks::default();
        let both = vec![
            gone.to_string_lossy().into_owned(),
            kept.to_string_lossy().into_owned(),
        ];
        stage(&locks, &root, "ws-1", &both).unwrap().unwrap();

        // The pane in `gone` closed; then the user empties the library.
        delete(&global(&root), "review").unwrap();
        let shrunk = vec![kept.to_string_lossy().into_owned()];
        assert_eq!(stage(&locks, &root, "ws-1", &shrunk).unwrap(), None);
        // BOTH cwds are disarmed — the departed one via the manifest.
        assert!(!gone.join(".agents").exists());
        assert!(!kept.join(".agents").exists());
    }

    #[test]
    fn concurrent_same_ws_stagings_serialize_and_end_complete() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "x").unwrap();
        let root = std::sync::Arc::new(root);
        // ONE lock instance shared by both threads — the app's managed state.
        let locks = SkillsLocks::default();
        for _ in 0..8 {
            let a = std::sync::Arc::clone(&root);
            let b = std::sync::Arc::clone(&root);
            let (la, lb) = (locks.clone(), locks.clone());
            let ta = std::thread::spawn(move || stage(&la, &a, "ws-1", &[]).unwrap().unwrap());
            let tb = std::thread::spawn(move || stage(&lb, &b, "ws-1", &[]).unwrap().unwrap());
            ta.join().unwrap();
            tb.join().unwrap();
            // Whatever the interleaving, the published staging is complete.
            let staged = root.join("staging").join("ws-1");
            assert!(staged.join("skills").join("review").join(SKILL_FILE).exists());
            assert!(staged
                .join("claude-plugin")
                .join(".claude-plugin")
                .join("plugin.json")
                .exists());
        }
    }

    #[test]
    fn an_unreadable_skill_is_skipped_not_fatal_matching_list() {
        let (_tmp, root) = root();
        save(&global(&root), "good", "fine").unwrap();
        save(&global(&root), "bad", "x").unwrap();
        fs::write(global(&root).join("bad").join(SKILL_FILE), [0xff, 0xfe, 0x00]).unwrap();

        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap().unwrap();
        let skills = PathBuf::from(&views.skills_dir);
        assert!(skills.join("good").exists());
        assert!(!skills.join("bad").exists());
        // list() treats the same file the same way — the two views agree.
        let listed = list(&root).unwrap();
        let names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["good"]);
    }

    #[test]
    fn copy_skips_write_atomics_transient_sibling() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "x").unwrap();
        fs::write(global(&root).join("review").join("SKILL.md.tmp"), "torn").unwrap();

        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap().unwrap();
        let staged = PathBuf::from(&views.skills_dir).join("review");
        assert!(staged.join(SKILL_FILE).exists());
        assert!(!staged.join("SKILL.md.tmp").exists());
    }

    #[test]
    fn other_workspaces_skills_stay_out_of_a_staging() {
        let (_tmp, root) = root();
        save(&ws(&root, "ws-1"), "mine", "x").unwrap();
        save(&ws(&root, "ws-2"), "theirs", "x").unwrap();

        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap().unwrap();
        let skills = PathBuf::from(&views.skills_dir);
        assert!(skills.join("mine").exists());
        assert!(!skills.join("theirs").exists());
    }

    #[test]
    fn pruning_views_drops_dead_workspaces_and_spares_live_ones_and_the_library() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "x").unwrap();
        save(&ws(&root, "ws-dead"), "gone", "x").unwrap();
        stage(&SkillsLocks::default(), &root, "ws-live", &[]).unwrap().unwrap();
        stage(&SkillsLocks::default(), &root, "ws-dead", &[]).unwrap().unwrap();
        // A crash leftover of a dead workspace's build.
        fs::create_dir_all(root.join("staging").join(".tmp-ws-dead")).unwrap();

        prune_views(&root, &["ws-live".into()]).unwrap();

        for parent in ["staging", "opencode"] {
            assert!(root.join(parent).join("ws-live").exists(), "{parent} live");
            assert!(!root.join(parent).join("ws-dead").exists(), "{parent} dead");
        }
        assert!(!root.join("staging").join(".tmp-ws-dead").exists());
        // The library — user content, dead workspace or not — is untouched.
        assert!(ws(&root, "ws-dead").join("gone").join(SKILL_FILE).exists());
    }
}
