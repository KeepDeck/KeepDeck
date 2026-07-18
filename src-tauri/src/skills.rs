//! The shared skills library and its per-workspace staging views.
//!
//! KeepDeck-authored agent skills (the open SKILL.md format) live under
//! KeepDeck's own home — never inside a repo and never in any CLI's dotfiles:
//!
//! - `<keepdeck_home>/skills/library/global/<skill>/SKILL.md`
//! - `<keepdeck_home>/skills/library/ws/<wsId>/<skill>/SKILL.md`
//!
//! At spawn time the host asks for a workspace's STAGING: derived views over
//! global + workspace skills (a workspace skill wins a name clash), one per
//! CLI injection dialect, rebuilt from scratch on every request so a view can
//! never serve a deleted or stale skill:
//!
//! - `staging/<wsId>/claude-plugin/` — a Claude Code plugin dir
//!   (`.claude-plugin/plugin.json` + `skills/`) for `--plugin-dir`
//! - `staging/<wsId>/skills/` — the bare standard layout (`<skill>/SKILL.md`
//!   at top level) for kimi's `--skills-dir`; the same shape codex's
//!   `.agents/skills` would take once its injection lands
//! - `opencode/<wsId>/` — an OpenCode config dir for `OPENCODE_CONFIG_DIR`,
//!   carrying each skill twice: under `skills/` for the model's own `skill`
//!   tool, and as a generated `command/<name>.md` so the skill is USER-
//!   visible too — opencode surfaces no skill listing or slash form of its
//!   own, and without the command a loaded skill is invisible in the UI.
//!   STABLE, not under `staging/`: opencode treats the directory as a
//!   writable config home (it installs plugin node_modules and drops
//!   account/state files there — field-verified on 1.18.3), so only the
//!   `skills/` and `command/` subtrees are KeepDeck's to replace;
//!   everything else in it must survive every rebuild.
//!
//! CODEX has no injection door at all (no flag, no env, no config key), but
//! it reads the STANDARD project location `.agents/skills` at a repo root —
//! so skills become a property of KeepDeck-managed worktrees: staging arms
//! each of the workspace's worktree roots with a SYMLINK
//! `<worktree>/.agents/skills` → the staged bare view, and a `/.agents/`
//! line in the repo's shared `info/exclude` keeps git blind to it. A
//! symlink pointing into KeepDeck's home is provably OURS — a real
//! directory there is the user's and is never touched. Panes running in
//! the user's main checkout stay uninjected on purpose.
//!
//! Frontmatter and schema knowledge stay in TS (`src/domain/skills`), next to
//! the model; this adapter only moves bytes: list, save, delete, stage.

use serde::Serialize;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use crate::state::write_atomic;

const SKILL_FILE: &str = "SKILL.md";

/// The Claude-plugin wrapper manifest a staged `--plugin-dir` needs. The
/// plugin name prefixes skill invocations (`keepdeck-skills:<name>`), so it
/// stays stable — renaming it would rename every staged skill.
const CLAUDE_PLUGIN_MANIFEST: &str = concat!(
    r#"{"name": "keepdeck-skills", "#,
    r#""description": "Skills shared through KeepDeck", "#,
    r#""version": "0.1.0"}"#,
);

/// One library skill on the wire (mirrors the TS `StoredSkill`, camelCase).
/// Content rides along — skills are small and the list IS the read path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDto {
    pub scope: String,
    pub ws_id: Option<String>,
    pub name: String,
    pub content: String,
}

/// A workspace's staged views, absolute paths (mirrors the TS
/// `SkillsStagingViews`, camelCase). `opencode_config_dir` is the STABLE
/// per-workspace dir (opencode writes its own state there); the other two
/// live under the wiped `staging/<wsId>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStagingDto {
    pub claude_plugin_dir: String,
    pub opencode_config_dir: String,
    pub skills_dir: String,
}

/// Every skill in the library, global scope first, then workspaces, names
/// alphabetical — a deterministic order the UI can render as-is.
#[tauri::command(async)]
pub fn skills_list() -> Result<Vec<SkillDto>, String> {
    list(&skills_root()?).map_err(|e| e.to_string())
}

/// Create or overwrite one skill's `SKILL.md` (content is composed and
/// validated by the webview; this side only refuses unsafe path segments).
#[tauri::command(async)]
pub fn skills_save(
    scope: String,
    ws_id: Option<String>,
    name: String,
    content: String,
) -> Result<(), String> {
    let root = skills_root()?;
    let dir = scope_dir(&root, &scope, ws_id.as_deref())?;
    save(&dir, &name, &content).map_err(|e| e.to_string())
}

/// Remove one skill's directory entirely (assets included). Missing is fine.
#[tauri::command(async)]
pub fn skills_delete(scope: String, ws_id: Option<String>, name: String) -> Result<(), String> {
    let root = skills_root()?;
    let dir = scope_dir(&root, &scope, ws_id.as_deref())?;
    delete(&dir, &name).map_err(|e| e.to_string())
}

/// Rebuild and return the staged views for one workspace — `None` when the
/// library holds nothing for it (callers then inject no skills at all).
/// `worktree_roots` are the workspace's worktree pane roots: each gets the
/// codex-facing `.agents/skills` symlink armed (or disarmed when empty).
#[tauri::command(async)]
pub fn skills_stage(
    ws_id: String,
    worktree_roots: Vec<String>,
) -> Result<Option<SkillStagingDto>, String> {
    let root = skills_root()?;
    require_safe(&ws_id, "workspace id")?;
    stage(&root, &ws_id, &worktree_roots).map_err(|e| e.to_string())
}

/// Remove KeepDeck's `.agents/skills` symlinks from the given worktree
/// roots — the closing workspace's worktrees must not keep dangling links
/// once their staging is pruned. Only provably-ours links are touched.
#[tauri::command(async)]
pub fn skills_disarm(worktree_roots: Vec<String>) -> Result<(), String> {
    let root = skills_root()?;
    disarm_worktrees(&root, &worktree_roots).map_err(|e| e.to_string())
}

/// Drop the DERIVED per-workspace dirs (staging views, opencode config
/// homes) of workspaces that no longer exist — closed workspaces must not
/// keep dead copies around forever. The library is user content and is
/// never touched here.
#[tauri::command(async)]
pub fn skills_prune(live_ws_ids: Vec<String>) -> Result<(), String> {
    prune(&skills_root()?, &live_ws_ids).map_err(|e| e.to_string())
}

fn skills_root() -> Result<PathBuf, String> {
    let home = crate::paths::keepdeck_home().ok_or("no home directory for skills")?;
    Ok(home.join("skills"))
}

/// Path-segment safety shared by skill names and workspace ids: one plain
/// directory name, no traversal. The friendlier naming rules (kebab-case
/// etc.) are the webview's business.
fn require_safe(segment: &str, what: &str) -> Result<(), String> {
    let ok = !segment.is_empty()
        && segment.len() <= 64
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && segment.starts_with(|c: char| c.is_ascii_alphanumeric());
    if ok {
        Ok(())
    } else {
        Err(format!("unsafe {what}: {segment:?}"))
    }
}

/// The library directory a scope stores its skills in.
fn scope_dir(root: &Path, scope: &str, ws_id: Option<&str>) -> Result<PathBuf, String> {
    match (scope, ws_id) {
        ("global", None) => Ok(root.join("library").join("global")),
        ("workspace", Some(ws)) => {
            require_safe(ws, "workspace id")?;
            Ok(root.join("library").join("ws").join(ws))
        }
        _ => Err(format!("invalid scope: {scope:?} (wsId {ws_id:?})")),
    }
}

fn list(root: &Path) -> io::Result<Vec<SkillDto>> {
    let mut out = Vec::new();
    let library = root.join("library");
    for (name, content) in scope_skills(&library.join("global"))? {
        out.push(SkillDto {
            scope: "global".into(),
            ws_id: None,
            name,
            content,
        });
    }
    for ws in sorted_dirs(&library.join("ws"))? {
        let ws_id = ws.file_name().unwrap_or_default().to_string_lossy().into_owned();
        for (name, content) in scope_skills(&ws)? {
            out.push(SkillDto {
                scope: "workspace".into(),
                ws_id: Some(ws_id.clone()),
                name,
                content,
            });
        }
    }
    Ok(out)
}

/// `(name, SKILL.md content)` per skill directory, names alphabetical.
/// Directories without a `SKILL.md` are not skills and are skipped.
fn scope_skills(dir: &Path) -> io::Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    for skill in sorted_dirs(dir)? {
        let Ok(content) = fs::read_to_string(skill.join(SKILL_FILE)) else {
            continue;
        };
        let name = skill.file_name().unwrap_or_default().to_string_lossy().into_owned();
        out.push((name, content));
    }
    Ok(out)
}

/// Subdirectories of `dir`, name-sorted; a missing `dir` is just empty.
fn sorted_dirs(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    Ok(dirs)
}

fn save(scope_dir: &Path, name: &str, content: &str) -> io::Result<()> {
    require_safe(name, "skill name").map_err(io::Error::other)?;
    write_atomic(&scope_dir.join(name).join(SKILL_FILE), content.as_bytes())
}

fn delete(scope_dir: &Path, name: &str) -> io::Result<()> {
    require_safe(name, "skill name").map_err(io::Error::other)?;
    match fs::remove_dir_all(scope_dir.join(name)) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn stage(
    root: &Path,
    ws_id: &str,
    worktree_roots: &[String],
) -> io::Result<Option<SkillStagingDto>> {
    let library = root.join("library");
    let final_dir = root.join("staging").join(ws_id);
    // opencode's view lives OUTSIDE the wiped staging: opencode writes its
    // own files into its config dir, and those must survive every rebuild —
    // only the `skills/` subtree below this dir is KeepDeck's.
    let opencode_dir = root.join("opencode").join(ws_id);

    // Workspace skills override same-named global ones: collect global
    // first, then let the workspace pass replace by name.
    let mut sources: Vec<(String, PathBuf)> = Vec::new();
    for scope in [library.join("global"), library.join("ws").join(ws_id)] {
        for skill in sorted_dirs(&scope)? {
            if !skill.join(SKILL_FILE).is_file() {
                continue;
            }
            let name = skill.file_name().unwrap_or_default().to_string_lossy().into_owned();
            sources.retain(|(existing, _)| *existing != name);
            sources.push((name, skill));
        }
    }

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
        disarm_worktrees(root, worktree_roots)?;
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
        for view in [
            claude_plugin.join("skills"),
            tmp.join("skills"),
            opencode_tmp.clone(),
        ] {
            copy_dir(source, &view.join(name))?;
        }
        // The user-facing half of the opencode view: a /name command whose
        // palette description is the skill's own, pointing the agent at the
        // staged SKILL.md (the command file must not go stale on edits, so
        // it references rather than inlines).
        let staged_skill = opencode_dir.join("skills").join(name).join(SKILL_FILE);
        let command = opencode_command(name, source, &staged_skill)?;
        write_atomic(
            &opencode_cmd_tmp.join(format!("{name}.md")),
            command.as_bytes(),
        )?;
    }
    match fs::remove_dir_all(&final_dir) {
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        other => other?,
    }
    fs::create_dir_all(final_dir.parent().unwrap_or(root))?;
    fs::rename(&tmp, &final_dir)?;
    let opencode_skills = opencode_dir.join("skills");
    match fs::remove_dir_all(&opencode_skills) {
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        other => other?,
    }
    fs::rename(&opencode_tmp, &opencode_skills)?;
    let opencode_commands = opencode_dir.join("command");
    match fs::remove_dir_all(&opencode_commands) {
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        other => other?,
    }
    fs::rename(&opencode_cmd_tmp, &opencode_commands)?;

    arm_worktrees(root, &final_dir.join("skills"), worktree_roots)?;

    let abs = |dir: &Path| dir.to_string_lossy().into_owned();
    Ok(Some(SkillStagingDto {
        claude_plugin_dir: abs(&final_dir.join("claude-plugin")),
        opencode_config_dir: abs(&opencode_dir),
        skills_dir: abs(&final_dir.join("skills")),
    }))
}

/// The codex-facing arm: `<worktree>/.agents/skills` → the staged bare view.
/// A real (non-symlink) entry there is the user's own and is left alone; a
/// foreign symlink (target outside KeepDeck's skills root) likewise. The
/// exclude line is best-effort — a repo whose metadata can't be resolved
/// still gets the skills, just with an untracked `.agents/` in its status.
fn arm_worktrees(root: &Path, staged_skills: &Path, worktree_roots: &[String]) -> io::Result<()> {
    for wt in worktree_roots {
        let wt = Path::new(wt);
        if !wt.is_dir() {
            continue;
        }
        let agents = wt.join(".agents");
        let link = agents.join("skills");
        match fs::symlink_metadata(&link) {
            Ok(meta) if meta.file_type().is_symlink() => {
                if fs::read_link(&link)? == staged_skills {
                    // Already correct — content freshness comes from staging.
                } else if link_is_ours(&link, root) {
                    fs::remove_file(&link)?;
                    symlink_dir(staged_skills, &link)?;
                } else {
                    continue; // someone else's link — hands off
                }
            }
            Ok(_) => continue, // the user's real .agents/skills — hands off
            Err(e) if e.kind() == ErrorKind::NotFound => {
                fs::create_dir_all(&agents)?;
                symlink_dir(staged_skills, &link)?;
            }
            Err(e) => return Err(e),
        }
        if let Err(e) = ensure_excluded(wt) {
            log::warn!("skills: exclude line for {} failed: {e}", wt.display());
        }
    }
    Ok(())
}

/// Remove OUR symlinks (and a `.agents` dir they leave empty) from the
/// given worktree roots. Anything not provably ours stays.
fn disarm_worktrees(root: &Path, worktree_roots: &[String]) -> io::Result<()> {
    for wt in worktree_roots {
        let agents = Path::new(wt).join(".agents");
        let link = agents.join("skills");
        match fs::symlink_metadata(&link) {
            Ok(meta) if meta.file_type().is_symlink() && link_is_ours(&link, root) => {
                fs::remove_file(&link)?;
                // Only vanishes when the link was its sole content.
                let _ = fs::remove_dir(&agents);
            }
            _ => {}
        }
    }
    Ok(())
}

/// A link is ours iff it points inside KeepDeck's skills root.
fn link_is_ours(link: &Path, skills_root: &Path) -> bool {
    fs::read_link(link).is_ok_and(|target| target.starts_with(skills_root))
}

#[cfg(unix)]
fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

/// Idempotently append `/.agents/` to the repo's SHARED `info/exclude` so
/// the armed dir never shows up in git status or a commit. The exclude file
/// lives in the common git dir — resolved through the worktree's `.git`
/// file and its `commondir` pointer.
fn ensure_excluded(worktree_root: &Path) -> io::Result<()> {
    const LINE: &str = "/.agents/";
    let Some(exclude) = git_info_exclude(worktree_root)? else {
        return Ok(());
    };
    let current = match fs::read_to_string(&exclude) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    if current.lines().any(|l| l.trim() == LINE) {
        return Ok(());
    }
    let sep = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    write_atomic(&exclude, format!("{current}{sep}{LINE}\n").as_bytes())
}

/// The `info/exclude` of the repo a worktree belongs to, or `None` when the
/// root isn't recognizably a git checkout.
fn git_info_exclude(worktree_root: &Path) -> io::Result<Option<PathBuf>> {
    let dotgit = worktree_root.join(".git");
    if dotgit.is_dir() {
        return Ok(Some(dotgit.join("info").join("exclude")));
    }
    let pointer = match fs::read_to_string(&dotgit) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let Some(gitdir) = pointer.trim().strip_prefix("gitdir:") else {
        return Ok(None);
    };
    let gitdir = worktree_root.join(gitdir.trim());
    // A linked worktree's gitdir carries a `commondir` pointer to the main
    // `.git`; without one, the gitdir IS the common dir.
    let common = match fs::read_to_string(gitdir.join("commondir")) {
        Ok(rel) => gitdir.join(rel.trim()),
        Err(e) if e.kind() == ErrorKind::NotFound => gitdir,
        Err(e) => return Err(e),
    };
    Ok(Some(common.join("info").join("exclude")))
}

/// `.tmp-<id>` build leftovers follow the same liveness rule as the dirs
/// themselves, so an in-flight stage of a LIVE workspace can never lose its
/// build-aside dir to a concurrent prune.
fn prune(root: &Path, live: &[String]) -> io::Result<()> {
    for parent in [root.join("staging"), root.join("opencode")] {
        for dir in sorted_dirs(&parent)? {
            let name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let id = name.strip_prefix(".tmp-").unwrap_or(&name);
            if live.iter().any(|l| l == id) {
                continue;
            }
            fs::remove_dir_all(&dir)?;
        }
    }
    Ok(())
}

/// The generated `/name` command for opencode: it surfaces no skill listing
/// or slash form of its own, so each skill doubles as a palette command
/// whose description is the skill's own, pointing the agent at the staged
/// SKILL.md (a reference, not a copy of the body — it cannot go stale).
fn opencode_command(name: &str, source: &Path, staged_skill: &Path) -> io::Result<String> {
    let skill = fs::read_to_string(source.join(SKILL_FILE))?;
    let description = frontmatter_line(&skill, "description").unwrap_or_default();
    Ok(format!(
        "---\ndescription: {description}\n---\nUse the \"{name}\" skill: read {} and follow its \
         instructions for this request: $ARGUMENTS\n",
        staged_skill.display(),
    ))
}

/// Best-effort raw value of one `key:` line inside the frontmatter fence.
/// Schema knowledge stays TS-side — this lifts a line the library already
/// stores as valid YAML and re-emits it verbatim.
fn frontmatter_line(content: &str, key: &str) -> Option<String> {
    let rest = content.strip_prefix("---\n")?;
    let fence = rest.find("\n---\n")?;
    rest[..fence].lines().find_map(|line| {
        line.strip_prefix(key)?
            .strip_prefix(':')
            .map(|value| value.trim().to_string())
    })
}

/// Copy a skill directory tree (assets included). Symlinks are followed —
/// the library is KeepDeck-authored, a link is the author's own doing.
fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("skills");
        (dir, root)
    }

    fn global(root: &Path) -> PathBuf {
        root.join("library").join("global")
    }

    fn ws(root: &Path, id: &str) -> PathBuf {
        root.join("library").join("ws").join(id)
    }

    #[test]
    fn save_list_roundtrip_orders_global_before_workspaces() {
        let (_tmp, root) = root();
        save(&ws(&root, "ws-2"), "review", "ws two").unwrap();
        save(&global(&root), "review", "global review").unwrap();
        save(&global(&root), "deploy", "global deploy").unwrap();

        let all = list(&root).unwrap();
        let brief: Vec<(&str, Option<&str>, &str)> = all
            .iter()
            .map(|s| (s.scope.as_str(), s.ws_id.as_deref(), s.name.as_str()))
            .collect();
        assert_eq!(
            brief,
            vec![
                ("global", None, "deploy"),
                ("global", None, "review"),
                ("workspace", Some("ws-2"), "review"),
            ]
        );
        assert_eq!(all[1].content, "global review");

        // The wire shape the webview reads — pin the camelCase field.
        let json = serde_json::to_value(&all[2]).unwrap();
        assert_eq!(json["wsId"], "ws-2");
        assert_eq!(json["scope"], "workspace");
    }

    #[test]
    fn unsafe_names_are_refused() {
        let (_tmp, root) = root();
        for bad in ["", "../evil", "a/b", ".hidden", "-lead", &"x".repeat(65)] {
            assert!(save(&global(&root), bad, "x").is_err(), "accepted {bad:?}");
        }
        assert!(scope_dir(&root, "workspace", Some("../up")).is_err());
        assert!(scope_dir(&root, "workspace", None).is_err());
        assert!(scope_dir(&root, "other", None).is_err());
    }

    #[test]
    fn save_overwrites_and_delete_removes() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "v1").unwrap();
        save(&global(&root), "review", "v2").unwrap();
        assert_eq!(list(&root).unwrap()[0].content, "v2");

        delete(&global(&root), "review").unwrap();
        assert!(list(&root).unwrap().is_empty());
        delete(&global(&root), "review").unwrap(); // missing is fine
    }

    #[test]
    fn stage_builds_all_three_views_with_workspace_override() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "global review").unwrap();
        save(&global(&root), "deploy", "deploy").unwrap();
        save(&ws(&root, "ws-1"), "review", "ws review").unwrap();
        // An asset rides along with its skill.
        fs::write(global(&root).join("deploy").join("notes.txt"), "asset").unwrap();

        let views = stage(&root, "ws-1", &[]).unwrap().unwrap();
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

        let views = stage(&root, "ws-1", &[]).unwrap().unwrap();
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
        let views = stage(&root, "ws-1", &[]).unwrap().unwrap();

        // opencode treats its config dir as writable (node_modules, account
        // files) — plant a stand-in next to the skills subtree.
        let oc = PathBuf::from(&views.opencode_config_dir);
        fs::write(oc.join("antigravity-accounts.json"), "precious").unwrap();

        save(&global(&root), "deploy", "y").unwrap();
        stage(&root, "ws-1", &[]).unwrap().unwrap();
        assert_eq!(
            fs::read_to_string(oc.join("antigravity-accounts.json")).unwrap(),
            "precious",
        );
        assert!(oc.join("skills").join("deploy").exists());

        // An emptied library removes ONLY KeepDeck's subtrees.
        delete(&global(&root), "review").unwrap();
        delete(&global(&root), "deploy").unwrap();
        assert_eq!(stage(&root, "ws-1", &[]).unwrap(), None);
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
        let views = stage(&root, "ws-1", &[]).unwrap().unwrap();

        delete(&global(&root), "deploy").unwrap();
        stage(&root, "ws-1", &[]).unwrap().unwrap();
        let skills = PathBuf::from(&views.skills_dir);
        assert!(skills.join("review").exists());
        assert!(!skills.join("deploy").exists());
    }

    #[test]
    fn empty_library_stages_nothing_and_clears_stale_views() {
        let (_tmp, root) = root();
        assert_eq!(stage(&root, "ws-1", &[]).unwrap(), None);

        save(&ws(&root, "ws-1"), "review", "x").unwrap();
        stage(&root, "ws-1", &[]).unwrap().unwrap();
        delete(&ws(&root, "ws-1"), "review").unwrap();
        assert_eq!(stage(&root, "ws-1", &[]).unwrap(), None);
        assert!(!root.join("staging").join("ws-1").exists());
    }

    /// A fake linked-worktree checkout: `main/.git/` (common dir) plus a
    /// worktree whose `.git` FILE points at `main/.git/worktrees/wt` with a
    /// `commondir` back-pointer — the layout `git worktree add` produces,
    /// built by hand so the test needs no git binary.
    fn fake_worktree(base: &Path) -> PathBuf {
        let common = base.join("main").join(".git");
        let gitdir = common.join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        wt
    }

    #[test]
    fn staging_arms_a_worktree_with_an_owned_symlink_and_excludes_it() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        save(&global(&root), "review", "x").unwrap();

        let roots = vec![wt.to_string_lossy().into_owned()];
        let views = stage(&root, "ws-1", &roots).unwrap().unwrap();

        let link = wt.join(".agents").join("skills");
        assert_eq!(
            fs::read_link(&link).unwrap(),
            PathBuf::from(&views.skills_dir),
        );
        // The skill is reachable THROUGH the link, as codex would read it.
        assert!(link.join("review").join(SKILL_FILE).exists());

        // The exclude line lands in the COMMON git dir, exactly once even
        // after restaging.
        stage(&root, "ws-1", &roots).unwrap().unwrap();
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
    fn a_users_real_agents_dir_is_never_touched() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        let theirs = wt.join(".agents").join("skills");
        fs::create_dir_all(theirs.join("their-skill")).unwrap();
        save(&global(&root), "review", "x").unwrap();

        let roots = vec![wt.to_string_lossy().into_owned()];
        stage(&root, "ws-1", &roots).unwrap().unwrap();
        assert!(theirs.join("their-skill").exists());
        assert!(!fs::symlink_metadata(&theirs).unwrap().file_type().is_symlink());

        // Emptying the library leaves it alone too.
        delete(&global(&root), "review").unwrap();
        assert_eq!(stage(&root, "ws-1", &roots).unwrap(), None);
        assert!(theirs.join("their-skill").exists());
    }

    #[test]
    fn emptied_library_disarms_and_removes_an_empty_agents_dir() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        save(&global(&root), "review", "x").unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];
        stage(&root, "ws-1", &roots).unwrap().unwrap();

        delete(&global(&root), "review").unwrap();
        assert_eq!(stage(&root, "ws-1", &roots).unwrap(), None);
        assert!(!wt.join(".agents").exists());
    }

    #[test]
    fn disarm_spares_a_foreign_symlink_and_company_in_agents() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        let agents = wt.join(".agents");
        fs::create_dir_all(&agents).unwrap();
        // A skills link the USER made (target outside our home) and a
        // sibling file: both must survive our disarm.
        let elsewhere = root.parent().unwrap().join("their-skills");
        fs::create_dir_all(&elsewhere).unwrap();
        symlink_dir(&elsewhere, &agents.join("skills")).unwrap();
        fs::write(agents.join("notes.txt"), "keep").unwrap();

        disarm_worktrees(&root, &[wt.to_string_lossy().into_owned()]).unwrap();
        assert!(agents.join("skills").exists());
        assert!(agents.join("notes.txt").exists());
    }

    #[test]
    fn prune_drops_dead_workspaces_and_spares_live_ones_and_the_library() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "x").unwrap();
        save(&ws(&root, "ws-dead"), "gone", "x").unwrap();
        stage(&root, "ws-live", &[]).unwrap().unwrap();
        stage(&root, "ws-dead", &[]).unwrap().unwrap();
        // A crash leftover of a dead workspace's build.
        fs::create_dir_all(root.join("staging").join(".tmp-ws-dead")).unwrap();

        prune(&root, &["ws-live".into()]).unwrap();

        for parent in ["staging", "opencode"] {
            assert!(root.join(parent).join("ws-live").exists(), "{parent} live");
            assert!(!root.join(parent).join("ws-dead").exists(), "{parent} dead");
        }
        assert!(!root.join("staging").join(".tmp-ws-dead").exists());
        // The library — user content, dead workspace or not — is untouched.
        assert!(ws(&root, "ws-dead").join("gone").join(SKILL_FILE).exists());
    }

    #[test]
    fn prune_on_a_fresh_home_is_a_no_op() {
        let (_tmp, root) = root();
        prune(&root, &["ws-1".into()]).unwrap();
    }

    #[test]
    fn other_workspaces_skills_stay_out_of_a_staging() {
        let (_tmp, root) = root();
        save(&ws(&root, "ws-1"), "mine", "x").unwrap();
        save(&ws(&root, "ws-2"), "theirs", "x").unwrap();

        let views = stage(&root, "ws-1", &[]).unwrap().unwrap();
        let skills = PathBuf::from(&views.skills_dir);
        assert!(skills.join("mine").exists());
        assert!(!skills.join("theirs").exists());
    }
}
