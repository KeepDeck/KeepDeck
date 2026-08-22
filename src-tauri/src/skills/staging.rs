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
use super::bundled::BundledSkill;
use crate::worktree_arm::{record_armed, retire_key};
use super::library::{sorted_dirs, SKILL_FILE};
use super::opencode;

/// Per-workspace locks that serialize `stage()`. Tauri managed state, the
/// `RepoLocks` idiom: overlapping stagings for the SAME workspace share the
/// `.tmp-<ws>` build dir and a multi-step swap — without serialization the
/// loser can delete the winner's published staging and leave a dangling
/// codex symlink. App-scoped (not a process static) so tests get isolated
/// instances. A poisoned lock (a panicked stage) is recovered — the next
/// stage rebuilds from scratch anyway.
#[derive(Default, Clone)]
pub struct SkillsLocks {
    inner: std::sync::Arc<
        std::sync::Mutex<
            std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>,
        >,
    >,
}

impl SkillsLocks {
    fn for_ws(&self, ws_id: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        map.entry(ws_id.to_string()).or_default().clone()
    }
}

/// A workspace's staged views, absolute paths (mirrors the TS
/// `SkillsStagingViews`, camelCase). `opencode_config_dir` is the STABLE
/// per-workspace dir (opencode writes its own state there); the other two
/// live under the wiped `staging/<wsId>`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStagingDto {
    pub claude_plugin_dir: String,
    pub opencode_config_dir: String,
    pub skills_dir: String,
}
use crate::state::write_atomic;

/// The Claude-plugin wrapper manifest a staged `--plugin-dir` needs. The
/// plugin name prefixes skill invocations (`keepdeck-skills:<name>`), so it
/// stays stable — renaming it would rename every staged skill.
const CLAUDE_PLUGIN_MANIFEST: &str = concat!(
    r#"{"name": "keepdeck-skills", "#,
    r#""description": "Skills shared through KeepDeck", "#,
    r#""version": "0.1.0"}"#,
);

pub(super) fn stage(
    locks: &SkillsLocks,
    root: &Path,
    ws_id: &str,
    spawn_roots: &[String],
    tier: &[BundledSkill],
    claimed: bool,
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

    // The claim probe arrives as a plain bool from the tauri glue —
    // staging logic stays artifacts-free (the one-directional boundary).
    let sources = collect_sources(&library, ws_id, tier, claimed);

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
    for (name, source) in &sources {
        // The two materialization contracts, enforced by the match arms:
        // LIBRARY — a source deleted between collection and here is
        // SKIPPED outright (re-materializing it from the collected bytes
        // would resurrect a deleted skill for one stage; views copied
        // BEFORE the vanish are wiped too, so no view carries the ghost
        // the later ones dropped). BUNDLED — a constant cannot vanish:
        // the arm is UNCONDITIONAL (create dest + write, no copy_dir,
        // no present/rollback dance — wiring it into the vanish contract
        // would add a rollback path that can never fire).
        let views = [
            claude_plugin.join("skills"),
            tmp.join("skills"),
            opencode_tmp.clone(),
        ];
        let content: &str = match source {
            Source::Library { dir, content } => {
                let mut present = true;
                for view in &views {
                    let dest = view.join(name);
                    if !copy_dir(dir, &dest)? {
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
                content
            }
            Source::Bundled(content) => {
                for view in &views {
                    let dest = view.join(name);
                    fs::create_dir_all(&dest)?;
                    write_atomic(&dest.join(SKILL_FILE), content.as_bytes())?;
                }
                content
            }
        };
        // The user-facing half of the opencode view — BOTH arms reach it
        // (bundled entries materialize IDENTICALLY to library ones): a
        // /name command whose palette description is the skill's own,
        // pointing the agent at the staged SKILL.md (the command file
        // must not go stale on edits, so it references rather than
        // inlines).
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
/// The materialization source: a library skill carries its dir (copy_dir
/// materializes assets) AND its collected content (the staged SKILL.md is
/// written from the bytes read at collection); a bundled skill IS its
/// constant — no dir, no vanish, unconditional arm.
pub(super) enum Source {
    Library { dir: PathBuf, content: String },
    Bundled(&'static str),
}

/// One judge for "can this content arm": the description lift the
/// generated command itself uses, held to non-empty-after-trim. None and
/// empty and whitespace-only all refuse — the editor's own authoring rule
/// (agents drop or misfire on an empty description), enforced staging-side
/// on whatever reached disk anyway.
fn usable_description(content: &str) -> bool {
    opencode::frontmatter_line(content, "description")
        .is_some_and(|d| !d.trim().is_empty())
}

fn collect_sources(
    library: &Path,
    ws_id: &str,
    tier: &[BundledSkill],
    claimed: bool,
) -> Vec<(String, Source)> {
    let mut sources: Vec<(String, Source)> = Vec::new();
    // THE MERGE ORDER (the shadow rule as code): retain-then-push means
    // the LAST source WINS, so the tier enters FIRST — each library
    // scope then shadows it naturally; a ws skill outranks a global one
    // exactly as before. Appending the tier last would INVERT the
    // doctrine. The gate applies per skill: ungated always, gated only
    // while the claim probe is true (content must obey the same gate as
    // its tools — advice for absent tools is actively misleading).
    for skill in tier.iter().filter(|s| !s.gated || claimed) {
        // The guard, judged by the SAME lift the command generator uses:
        // a skill with no usable description stages NOWHERE — not the
        // views, not the command. A description-less SKILL.md once
        // synthesized a command whose empty frontmatter made opencode
        // refuse its ENTIRE config and killed the agent at spawn; no
        // consumer can choke on what never lands. First-party content
        // is pinned to always pass (bundled.rs); a skip here means the
        // binary shipped broken and the warn names the const.
        if !usable_description(skill.content) {
            log::warn!(
                "skills: bundled skill {} has no usable description — not armed",
                skill.name
            );
            continue;
        }
        sources.push((skill.name.to_string(), Source::Bundled(skill.content)));
    }
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
            // The same guard, BEFORE the retain: skipping after it would
            // have already retained the garbage OVER the tier's valid
            // same-name skill, leaving BOTH dead (the incident's exact
            // shape — the agent survives but no artifacts skill arms).
            // Skipping here never gathers the garbage, so the tier's
            // skill arms under the name: the shadow-FALLBACK semantics
            // the merge order exists for.
            if !usable_description(&content) {
                log::warn!(
                    "skills: {} has a SKILL.md with no usable description — not armed (edit or delete it in the library)",
                    skill.display(),
                );
                continue;
            }
            let name = skill.file_name().unwrap_or_default().to_string_lossy().into_owned();
            sources.retain(|(existing, _)| *existing != name);
            sources.push((
                name,
                Source::Library {
                    dir: skill,
                    content,
                },
            ));
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
    match fs::rename(tmp, final_dir) {
        // A tmp that was never created (a tier-only stage: no library
        // skill ever materialized into this view) renames nothing — the
        // final_dir's absence above already left the view clean.
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        other => other?,
    }
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
pub(super) fn prune_views(root: &Path, live: &[String]) -> io::Result<()> {
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

    /// Library/tier content as the collection guard requires it: a
    /// frontmatter description. The guard (usable_description) skips
    /// anything without one, so every arming fixture carries one — the
    /// skip behavior itself is pinned by the guard's own tests below.
    fn fm(desc: &str) -> String {
        format!("---\ndescription: {desc}\n---\n{desc}\n")
    }

    #[test]
    fn stage_builds_all_three_views_with_workspace_override() {
        let (_tmp, root) = root();
        save(&global(&root), "review", &fm("global review")).unwrap();
        save(&global(&root), "deploy", &fm("deploy body")).unwrap();
        save(&ws(&root, "ws-1"), "review", &fm("ws review")).unwrap();
        // An asset rides along with its skill.
        fs::write(global(&root).join("deploy").join("notes.txt"), "asset").unwrap();

        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap().unwrap();
        let claude = PathBuf::from(&views.claude_plugin_dir);
        let manifest = fs::read_to_string(claude.join(".claude-plugin").join("plugin.json")).unwrap();
        assert!(manifest.contains("keepdeck-skills"));

        for skills in [
            claude.join("skills"),
            PathBuf::from(&views.opencode_config_dir).join("skills"),
            PathBuf::from(&views.skills_dir),
        ] {
            let review = fs::read_to_string(skills.join("review").join(SKILL_FILE)).unwrap();
            assert_eq!(review, fm("ws review")); // workspace wins the clash
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

        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap().unwrap();
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
        save(&global(&root), "review", &fm("x")).unwrap();
        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap().unwrap();

        // opencode treats its config dir as writable (node_modules, account
        // files) — plant a stand-in next to the skills subtree.
        let oc = PathBuf::from(&views.opencode_config_dir);
        fs::write(oc.join("antigravity-accounts.json"), "precious").unwrap();

        save(&global(&root), "deploy", &fm("y")).unwrap();
        stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap().unwrap();
        assert_eq!(
            fs::read_to_string(oc.join("antigravity-accounts.json")).unwrap(),
            "precious",
        );
        assert!(oc.join("skills").join("deploy").exists());

        // An emptied library removes ONLY KeepDeck's subtrees.
        delete(&global(&root), "review").unwrap();
        delete(&global(&root), "deploy").unwrap();
        assert_eq!(stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap(), None);
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
        save(&global(&root), "review", &fm("x")).unwrap();
        save(&global(&root), "deploy", &fm("x")).unwrap();
        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap().unwrap();

        delete(&global(&root), "deploy").unwrap();
        stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap().unwrap();
        let skills = PathBuf::from(&views.skills_dir);
        assert!(skills.join("review").exists());
        assert!(!skills.join("deploy").exists());
    }

    #[test]
    fn empty_library_stages_nothing_and_clears_stale_views() {
        let (_tmp, root) = root();
        assert_eq!(stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap(), None);

        save(&ws(&root, "ws-1"), "review", &fm("x")).unwrap();
        stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap().unwrap();
        delete(&ws(&root, "ws-1"), "review").unwrap();
        assert_eq!(stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap(), None);
        assert!(!root.join("staging").join("ws-1").exists());
    }

    #[test]
    fn staging_arms_a_worktree_with_an_owned_symlink_and_excludes_it() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        save(&global(&root), "review", &fm("x")).unwrap();

        let roots = vec![wt.to_string_lossy().into_owned()];
        let views = stage(&SkillsLocks::default(), &root, "ws-1", &roots, &[], false).unwrap().unwrap();

        let link = wt.join(".agents").join("skills");
        assert_eq!(
            fs::read_link(&link).unwrap(),
            PathBuf::from(&views.skills_dir),
        );
        // The skill is reachable THROUGH the link, as codex would read it.
        assert!(link.join("review").join(SKILL_FILE).exists());

        // The exclude line lands in the COMMON git dir, exactly once even
        // after restaging.
        stage(&SkillsLocks::default(), &root, "ws-1", &roots, &[], false).unwrap().unwrap();
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
        save(&global(&root), "review", &fm("x")).unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];
        stage(&SkillsLocks::default(), &root, "ws-1", &roots, &[], false).unwrap().unwrap();

        delete(&global(&root), "review").unwrap();
        assert_eq!(stage(&SkillsLocks::default(), &root, "ws-1", &roots, &[], false).unwrap(), None);
        assert!(!wt.join(".agents").exists());
    }

    #[test]
    fn emptying_the_library_disarms_cwds_that_left_the_spawn_roots() {
        let (_tmp, root) = root();
        let gone = root.parent().unwrap().join("closed-pane-cwd");
        let kept = root.parent().unwrap().join("open-pane-cwd");
        fs::create_dir_all(&gone).unwrap();
        fs::create_dir_all(&kept).unwrap();
        save(&global(&root), "review", &fm("x")).unwrap();
        let locks = SkillsLocks::default();
        let both = vec![
            gone.to_string_lossy().into_owned(),
            kept.to_string_lossy().into_owned(),
        ];
        stage(&locks, &root, "ws-1", &both, &[], false).unwrap().unwrap();

        // The pane in `gone` closed; then the user empties the library.
        delete(&global(&root), "review").unwrap();
        let shrunk = vec![kept.to_string_lossy().into_owned()];
        assert_eq!(stage(&locks, &root, "ws-1", &shrunk, &[], false).unwrap(), None);
        // BOTH cwds are disarmed — the departed one via the manifest.
        assert!(!gone.join(".agents").exists());
        assert!(!kept.join(".agents").exists());
    }

    #[test]
    fn concurrent_same_ws_stagings_serialize_and_end_complete() {
        let (_tmp, root) = root();
        save(&global(&root), "review", &fm("x")).unwrap();
        let root = std::sync::Arc::new(root);
        // ONE lock instance shared by both threads — the app's managed state.
        let locks = SkillsLocks::default();
        for _ in 0..8 {
            let a = std::sync::Arc::clone(&root);
            let b = std::sync::Arc::clone(&root);
            let (la, lb) = (locks.clone(), locks.clone());
            let ta = std::thread::spawn(move || stage(&la, &a, "ws-1", &[], &[], false).unwrap().unwrap());
            let tb = std::thread::spawn(move || stage(&lb, &b, "ws-1", &[], &[], false).unwrap().unwrap());
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
        save(&global(&root), "good", &fm("fine")).unwrap();
        save(&global(&root), "bad", &fm("x")).unwrap();
        fs::write(global(&root).join("bad").join(SKILL_FILE), [0xff, 0xfe, 0x00]).unwrap();

        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap().unwrap();
        let skills = PathBuf::from(&views.skills_dir);
        assert!(skills.join("good").exists());
        assert!(!skills.join("bad").exists());
        // list() treats the same file the same way — the two views agree.
        let listed = list(&root, &[]).unwrap();
        let names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["good"]);
    }

    #[test]
    fn copy_skips_write_atomics_transient_sibling() {
        let (_tmp, root) = root();
        save(&global(&root), "review", &fm("x")).unwrap();
        fs::write(global(&root).join("review").join("SKILL.md.tmp"), "torn").unwrap();

        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap().unwrap();
        let staged = PathBuf::from(&views.skills_dir).join("review");
        assert!(staged.join(SKILL_FILE).exists());
        assert!(!staged.join("SKILL.md.tmp").exists());
    }

    #[test]
    fn other_workspaces_skills_stay_out_of_a_staging() {
        let (_tmp, root) = root();
        save(&ws(&root, "ws-1"), "mine", &fm("x")).unwrap();
        save(&ws(&root, "ws-2"), "theirs", &fm("x")).unwrap();

        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[], &[], false).unwrap().unwrap();
        let skills = PathBuf::from(&views.skills_dir);
        assert!(skills.join("mine").exists());
        assert!(!skills.join("theirs").exists());
    }

    #[test]
    fn pruning_views_drops_dead_workspaces_and_spares_live_ones_and_the_library() {
        let (_tmp, root) = root();
        save(&global(&root), "review", &fm("x")).unwrap();
        save(&ws(&root, "ws-dead"), "gone", &fm("x")).unwrap();
        stage(&SkillsLocks::default(), &root, "ws-live", &[], &[], false).unwrap().unwrap();
        stage(&SkillsLocks::default(), &root, "ws-dead", &[], &[], false).unwrap().unwrap();
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

    // ---- the bundled tier's integration gates ----

    fn tier_skill(name: &'static str, gated: bool) -> BundledSkill {
        BundledSkill {
            name,
            content: "---\ndescription: static tier content\n---\nbody\n",
            gated,
        }
    }

    #[test]
    fn a_gated_tier_arms_only_while_claimed_and_never_shadows_the_library() {
        let (_tmp, root) = root();
        save(&global(&root), "alpha", &fm("alpha body")).unwrap();
        // Same-name day-one case: a user skill AND the bundled one.
        save(&global(&root), "bundled-one", &fm("user shadows this")).unwrap();
        let tier = [
            tier_skill("bundled-one", true),
            tier_skill("only-tier", true),
        ];

        // CLAIMED: the tier materializes; the same-name library row WINS
        // (the merge order — tier first, library retains over it).
        let views = stage(
            &SkillsLocks::default(),
            &root,
            "ws-1",
            &[],
            &tier,
            true,
        )
        .unwrap()
        .unwrap();
        let staged = std::fs::read_to_string(
            Path::new(&views.skills_dir).join("bundled-one").join(SKILL_FILE),
        )
        .unwrap();
        assert!(staged.contains("user shadows this"), "library wins: {staged}");
        assert!(
            (Path::new(&views.skills_dir).join("only-tier").join(SKILL_FILE)).exists(),
            "the tier materializes while claimed"
        );

        // UNCLAIMED: the gated tier is absent entirely — no stale arming
        // of advice for tools that are off.
        let views_off = stage(
            &SkillsLocks::default(),
            &root,
            "ws-1",
            &[],
            &tier,
            false,
        )
        .unwrap()
        .unwrap();
        assert!(
            !(Path::new(&views_off.skills_dir).join("only-tier")).exists(),
            "gated tier absent while unclaimed"
        );
        // The user's library skill still stages (the tier's gate is not
        // the library's).
        assert!(
            (Path::new(&views_off.skills_dir).join("alpha").join(SKILL_FILE)).exists()
        );
    }

    #[test]
    fn an_ungated_tier_arms_without_the_claim() {
        let (_tmp, root) = root();
        let tier = [tier_skill("always", false)];
        let views = stage(
            &SkillsLocks::default(),
            &root,
            "ws-1",
            &[],
            &tier,
            false, // unclaimed — the ungated skill arms anyway
        )
        .unwrap()
        .unwrap();
        assert!(
            (Path::new(&views.skills_dir).join("always").join(SKILL_FILE)).exists()
        );
    }

    #[test]
    fn empty_library_plus_claimed_tier_does_not_disarm() {
        // The disarm edge: "is there anything to arm" counts the GATED
        // tier — an empty library with a claimed tier still arms.
        let (_tmp, root) = root();
        let tier = [tier_skill("solo", true)];
        let views = stage(
            &SkillsLocks::default(),
            &root,
            "ws-1",
            &[],
            &tier,
            true,
        )
        .unwrap()
        .unwrap();
        assert!(
            (Path::new(&views.skills_dir).join("solo").join(SKILL_FILE)).exists(),
            "claimed tier alone keeps the arming alive"
        );

        // And the flip side: empty library + UNCLAIMED tier = nothing to
        // arm — the old disarm behavior, pinned.
        let off = stage(
            &SkillsLocks::default(),
            &root,
            "ws-1",
            &[],
            &tier,
            false,
        )
        .unwrap();
        assert!(off.is_none(), "unclaimed tier + empty library disarms");
    }

    // ---- the collection guard's own gates ----
    // The incident, pinned: a library file with no usable description
    // must not arm ANYWHERE — not poison a consumer's whole config —
    // and must not shadow the tier's valid same-name skill.

    #[test]
    fn a_descriptionless_library_row_is_skipped_and_the_tier_arms_under_the_name() {
        // The residue case VERBATIM: garbage global 'artifacts' beside
        // the valid bundled one. Collection-side skipping means the
        // garbage is never gathered — the bundled skill arms; a
        // materialization-side skip would have retained the garbage
        // over the tier first, leaving BOTH dead.
        let (_tmp, root) = root();
        fs::create_dir_all(global(&root).join("artifacts")).unwrap();
        fs::write(
            global(&root).join("artifacts").join(SKILL_FILE),
            "user's own copy",
        )
        .unwrap();
        let tier = [tier_skill("artifacts", true)];

        let views = stage(
            &SkillsLocks::default(),
            &root,
            "ws-1",
            &[],
            &tier,
            true,
        )
        .unwrap()
        .unwrap();
        let staged = std::fs::read_to_string(
            Path::new(&views.skills_dir).join("artifacts").join(SKILL_FILE),
        )
        .unwrap();
        assert!(
            staged.contains("static tier content"),
            "the bundled skill arms under the shadowed name: {staged}"
        );
        // The opencode command carries a REAL description — the poisoned
        // empty one is what killed the agent.
        let command = fs::read_to_string(
            Path::new(&views.opencode_config_dir)
                .join("command")
                .join("artifacts.md"),
        )
        .unwrap();
        assert!(command.starts_with("---\ndescription: static tier content\n---"));
    }

    #[test]
    fn a_broken_bundled_entry_is_skipped_not_armed() {
        // Symmetry: first-party content CAN ship broken (a bad include!
        // edit) — the guard holds both arms. The module pin in
        // bundled.rs keeps this arm theoretical by failing at test time.
        let (_tmp, root) = root();
        let tier = [
            BundledSkill {
                name: "broken",
                content: "no frontmatter at all",
                gated: false,
            },
            tier_skill("whole", false),
        ];
        let views = stage(
            &SkillsLocks::default(),
            &root,
            "ws-1",
            &[],
            &tier,
            false,
        )
        .unwrap()
        .unwrap();
        let skills = Path::new(&views.skills_dir);
        assert!(!skills.join("broken").exists(), "broken tier row skipped");
        assert!(skills.join("whole").exists(), "valid neighbor still arms");
    }

    #[test]
    fn the_list_still_shows_a_row_the_guard_skipped() {
        // The divergence is DELIBERATE and pinned so nobody "fixes" it:
        // list = what is on disk (fixable in the editor), staging = what
        // arms. A hidden broken row is unfixable.
        let (_tmp, root) = root();
        fs::create_dir_all(global(&root).join("broken")).unwrap();
        fs::write(global(&root).join("broken").join(SKILL_FILE), "no frontmatter").unwrap();
        save(&global(&root), "fine", &fm("fine body")).unwrap();

        let listed = list(&root, &[]).unwrap();
        let mut names: Vec<&str> = listed.iter().map(|s| s.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["broken", "fine"]);
    }

    #[test]
    fn a_ws_library_skill_shadows_the_tier_in_its_workspace() {
        // The full precedence: library-ws > bundled > library-global is
        // the staging order for the TIER; here the ws row must beat the
        // bundled one (the tier enters first, ws retains last).
        let (_tmp, root) = root();
        save(&ws(&root, "ws-1"), "only-tier", &fm("ws wins")).unwrap();
        let tier = [tier_skill("only-tier", true)];
        let views = stage(
            &SkillsLocks::default(),
            &root,
            "ws-1",
            &[],
            &tier,
            true,
        )
        .unwrap()
        .unwrap();
        let staged = std::fs::read_to_string(
            Path::new(&views.skills_dir).join("only-tier").join(SKILL_FILE),
        )
        .unwrap();
        assert!(staged.contains("ws wins"), "the ws library row wins: {staged}");
    }
}

