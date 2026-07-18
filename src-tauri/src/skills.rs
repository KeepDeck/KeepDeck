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
//! - `opencode/<wsId>/` — an OpenCode config dir (`skills/` subdir) for
//!   `OPENCODE_CONFIG_DIR`. STABLE, not under `staging/`: opencode treats
//!   the directory as a writable config home (it installs plugin
//!   node_modules and drops account/state files there — field-verified on
//!   1.18.3), so only its `skills/` subtree is KeepDeck's to replace;
//!   everything else in it must survive every rebuild.
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
#[tauri::command(async)]
pub fn skills_stage(ws_id: String) -> Result<Option<SkillStagingDto>, String> {
    let root = skills_root()?;
    require_safe(&ws_id, "workspace id")?;
    stage(&root, &ws_id).map_err(|e| e.to_string())
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

fn stage(root: &Path, ws_id: &str) -> io::Result<Option<SkillStagingDto>> {
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
        // opencode's own files next to its skills/ are not ours to touch.
        for stale in [final_dir, opencode_dir.join("skills")] {
            match fs::remove_dir_all(&stale) {
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                other => other?,
            }
        }
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
    match fs::remove_dir_all(&opencode_tmp) {
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        other => other?,
    }
    for (name, source) in &sources {
        for view in [
            claude_plugin.join("skills"),
            tmp.join("skills"),
            opencode_tmp.clone(),
        ] {
            copy_dir(source, &view.join(name))?;
        }
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

    let abs = |dir: &Path| dir.to_string_lossy().into_owned();
    Ok(Some(SkillStagingDto {
        claude_plugin_dir: abs(&final_dir.join("claude-plugin")),
        opencode_config_dir: abs(&opencode_dir),
        skills_dir: abs(&final_dir.join("skills")),
    }))
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

        let views = stage(&root, "ws-1").unwrap().unwrap();
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
    fn opencodes_own_files_survive_restaging_and_emptying() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "x").unwrap();
        let views = stage(&root, "ws-1").unwrap().unwrap();

        // opencode treats its config dir as writable (node_modules, account
        // files) — plant a stand-in next to the skills subtree.
        let oc = PathBuf::from(&views.opencode_config_dir);
        fs::write(oc.join("antigravity-accounts.json"), "precious").unwrap();

        save(&global(&root), "deploy", "y").unwrap();
        stage(&root, "ws-1").unwrap().unwrap();
        assert_eq!(
            fs::read_to_string(oc.join("antigravity-accounts.json")).unwrap(),
            "precious",
        );
        assert!(oc.join("skills").join("deploy").exists());

        // An emptied library removes ONLY the skills subtree.
        delete(&global(&root), "review").unwrap();
        delete(&global(&root), "deploy").unwrap();
        assert_eq!(stage(&root, "ws-1").unwrap(), None);
        assert!(!oc.join("skills").exists());
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
        let views = stage(&root, "ws-1").unwrap().unwrap();

        delete(&global(&root), "deploy").unwrap();
        stage(&root, "ws-1").unwrap().unwrap();
        let skills = PathBuf::from(&views.skills_dir);
        assert!(skills.join("review").exists());
        assert!(!skills.join("deploy").exists());
    }

    #[test]
    fn empty_library_stages_nothing_and_clears_stale_views() {
        let (_tmp, root) = root();
        assert_eq!(stage(&root, "ws-1").unwrap(), None);

        save(&ws(&root, "ws-1"), "review", "x").unwrap();
        stage(&root, "ws-1").unwrap().unwrap();
        delete(&ws(&root, "ws-1"), "review").unwrap();
        assert_eq!(stage(&root, "ws-1").unwrap(), None);
        assert!(!root.join("staging").join("ws-1").exists());
    }

    #[test]
    fn other_workspaces_skills_stay_out_of_a_staging() {
        let (_tmp, root) = root();
        save(&ws(&root, "ws-1"), "mine", "x").unwrap();
        save(&ws(&root, "ws-2"), "theirs", "x").unwrap();

        let views = stage(&root, "ws-1").unwrap().unwrap();
        let skills = PathBuf::from(&views.skills_dir);
        assert!(skills.join("mine").exists());
        assert!(!skills.join("theirs").exists());
    }
}
