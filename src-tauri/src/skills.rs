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
//! it reads the STANDARD location `.agents/skills` at its starting cwd (and
//! up to the repo root) once, at session start. So — per the user's rule
//! "skills live in the launched CLI's cwd, period" — staging arms EVERY
//! pane spawn cwd of the workspace with a SYMLINK `.agents/skills` → the
//! staged bare view, and a `/.agents/` line in the nearest repo's shared
//! `info/exclude` keeps git blind to it (a non-git cwd just skips the
//! exclude). A symlink pointing into KeepDeck's home is provably OURS — a
//! real directory there is the user's and is never touched.
//!
//! Frontmatter and schema knowledge stay in TS (`src/domain/skills`), next to
//! the model; this adapter only moves bytes: list, save, delete, stage.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::state::write_atomic;

/// Per-workspace locks that serialize `stage()`. Tauri managed state, the
/// `RepoLocks` idiom: overlapping stagings for the SAME workspace share the
/// `.tmp-<ws>` build dir and a multi-step swap — without serialization the
/// loser can delete the winner's published staging and leave a dangling
/// codex symlink. App-scoped (not a process static) so tests get isolated
/// instances. A poisoned lock (a panicked stage) is recovered — the next
/// stage rebuilds from scratch anyway.
#[derive(Default, Clone)]
pub struct SkillsLocks {
    inner: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl SkillsLocks {
    fn for_ws(&self, ws_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        map.entry(ws_id.to_string()).or_default().clone()
    }
}

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

/// Rename one skill by moving its whole directory — assets travel with it,
/// which a save-new-delete-old dance would silently drop. Refuses to move
/// onto an existing skill.
#[tauri::command(async)]
pub fn skills_rename(
    scope: String,
    ws_id: Option<String>,
    from: String,
    to: String,
) -> Result<(), String> {
    let root = skills_root()?;
    let dir = scope_dir(&root, &scope, ws_id.as_deref())?;
    rename(&dir, &from, &to).map_err(|e| e.to_string())
}

/// Rebuild and return the staged views for one workspace — `None` when the
/// library holds nothing for it (callers then inject no skills at all).
/// `roots` are the workspace's pane spawn cwds: each gets the codex-facing
/// `.agents/skills` symlink armed (or disarmed when empty).
#[tauri::command(async)]
pub fn skills_stage(
    locks: tauri::State<'_, SkillsLocks>,
    ws_id: String,
    roots: Vec<String>,
) -> Result<Option<SkillStagingDto>, String> {
    let root = skills_root()?;
    require_safe(&ws_id, "workspace id")?;
    stage(&locks, &root, &ws_id, &roots).map_err(|e| e.to_string())
}

/// Remove KeepDeck's `.agents/skills` symlinks from the given spawn cwds —
/// a closing workspace's directories must not keep dangling links once its
/// staging is pruned. Only provably-ours links are touched.
#[tauri::command(async)]
pub fn skills_disarm(roots: Vec<String>) -> Result<(), String> {
    let root = skills_root()?;
    disarm_roots(&root, &roots).map_err(|e| e.to_string())
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

fn rename(scope_dir: &Path, from: &str, to: &str) -> io::Result<()> {
    require_safe(from, "skill name").map_err(io::Error::other)?;
    require_safe(to, "skill name").map_err(io::Error::other)?;
    let target = scope_dir.join(to);
    if target.exists() {
        return Err(io::Error::other(format!("a skill named {to:?} already exists")));
    }
    fs::rename(scope_dir.join(from), target)
}

fn stage(
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
        let mut roots = manifest_roots(root, ws_id);
        for r in spawn_roots {
            if !roots.contains(r) {
                roots.push(r.clone());
            }
        }
        let claimed = claimed_by_others(root, ws_id);
        roots.retain(|r| !claimed.contains(r));
        disarm_roots(root, &roots)?;
        let _ = fs::remove_file(armed_manifest(root, ws_id));
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
        // deleted skill for one stage. (An empty dest dir from an earlier
        // view iteration is harmless: a dir without SKILL.md is not a skill
        // to any CLI, and the next stage drops it.)
        let mut present = true;
        for view in [
            claude_plugin.join("skills"),
            tmp.join("skills"),
            opencode_tmp.clone(),
        ] {
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
            continue;
        }
        // The user-facing half of the opencode view: a /name command whose
        // palette description is the skill's own, pointing the agent at the
        // staged SKILL.md (the command file must not go stale on edits, so
        // it references rather than inlines).
        let staged_skill = opencode_dir.join("skills").join(name).join(SKILL_FILE);
        let command = opencode_command(name, content, &staged_skill);
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
    record_armed(root, ws_id, &armed);

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

/// Where a workspace's armed spawn cwds are remembered, so a boot-time
/// `prune` can disarm the cwds of a workspace that died in a crash (the
/// deck no longer knows them; this file does).
fn armed_manifest(root: &Path, ws_id: &str) -> PathBuf {
    root.join("armed").join(ws_id)
}

/// The recorded armed cwds of one workspace (empty when absent/unreadable).
fn manifest_roots(root: &Path, ws_id: &str) -> Vec<String> {
    fs::read(armed_manifest(root, ws_id))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Every cwd some OTHER manifest still claims — a shared cwd must survive
/// one workspace's disarm while another workspace (live, or not yet
/// pruned) runs panes there.
fn claimed_by_others(root: &Path, except_ws: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root.join("armed")) else {
        return Vec::new();
    };
    let mut claimed = Vec::new();
    for entry in entries.flatten() {
        let ws = entry.file_name().to_string_lossy().into_owned();
        if ws == except_ws {
            continue;
        }
        claimed.extend(manifest_roots(root, &ws));
    }
    claimed
}

fn record_armed(root: &Path, ws_id: &str, armed: &[String]) {
    let path = armed_manifest(root, ws_id);
    let result = if armed.is_empty() {
        fs::remove_file(&path).or_else(|e| {
            if e.kind() == ErrorKind::NotFound { Ok(()) } else { Err(e) }
        })
    } else {
        serde_json::to_vec(armed)
            .map_err(io::Error::other)
            .and_then(|json| write_atomic(&path, &json))
    };
    if let Err(e) = result {
        log::warn!("skills: recording armed cwds for {ws_id} failed: {e}");
    }
}

/// The codex-facing arm: `<cwd>/.agents/skills` → the staged bare view, for
/// every pane spawn cwd. A real (non-symlink) entry there is the user's own
/// and is left alone; a foreign symlink (target outside KeepDeck's skills
/// root) likewise; a `.agents` that is itself a FILE or a SYMLINK is the
/// user's arrangement and is never written through. Wholly best-effort per
/// root — one odd cwd must not take the workspace's staging down — and the
/// successfully armed cwds are returned for the armed manifest.
fn arm_roots(root: &Path, staged_skills: &Path, spawn_roots: &[String]) -> Vec<String> {
    let mut armed = Vec::new();
    for wt in spawn_roots {
        match arm_one(root, staged_skills, Path::new(wt)) {
            Ok(true) => armed.push(wt.clone()),
            Ok(false) => {}
            Err(e) => log::warn!("skills: arming {wt} failed: {e}"),
        }
    }
    armed
}

/// Arm one spawn cwd; `Ok(true)` iff OUR link is (now) in place there.
fn arm_one(root: &Path, staged_skills: &Path, wt: &Path) -> io::Result<bool> {
    if !wt.is_dir() {
        return Ok(false);
    }
    let agents = wt.join(".agents");
    // `.agents` existing as anything but a real directory (a file, or a
    // symlink into the user's own tree) is the user's — creating our link
    // through it would write inside THEIR target.
    match fs::symlink_metadata(&agents) {
        Ok(meta) if !meta.file_type().is_dir() => return Ok(false),
        _ => {}
    }
    let link = agents.join("skills");
    match fs::symlink_metadata(&link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if fs::read_link(&link)? == staged_skills {
                // Already correct — content freshness comes from staging.
            } else if link_is_ours(&link, root) {
                fs::remove_file(&link)?;
                symlink_dir(staged_skills, &link)?;
            } else {
                return Ok(false); // someone else's link — hands off
            }
        }
        Ok(_) => return Ok(false), // the user's real .agents/skills — hands off
        Err(e) if e.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(&agents)?;
            symlink_dir(staged_skills, &link)?;
        }
        Err(e) => return Err(e),
    }
    if let Err(e) = ensure_excluded(wt) {
        log::warn!("skills: exclude line for {} failed: {e}", wt.display());
    }
    Ok(true)
}

/// Remove OUR symlinks (and a `.agents` dir they leave empty) from the
/// given spawn cwds, and drop the matching `info/exclude` lines arming
/// added. Anything not provably ours stays. Deliberately does NOT touch
/// the armed manifests: `record_armed` (stage) is their only writer and
/// `prune` their only reader — a stale entry costs one idempotent
/// re-disarm at the next boot, which the module accepts by contract.
fn disarm_roots(root: &Path, spawn_roots: &[String]) -> io::Result<()> {
    for wt in spawn_roots {
        let agents = Path::new(wt).join(".agents");
        let link = agents.join("skills");
        match fs::symlink_metadata(&link) {
            Ok(meta) if meta.file_type().is_symlink() && link_is_ours(&link, root) => {
                fs::remove_file(&link)?;
                // Only vanishes when the link was its sole content.
                let _ = fs::remove_dir(&agents);
                // Symmetry with ensure_excluded: the repo must not keep an
                // ignore line for an arming that no longer exists.
                if let Err(e) = remove_excluded(Path::new(wt)) {
                    log::warn!("skills: exclude cleanup for {wt} failed: {e}");
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Remove the exact anchored `/…/.agents/` line arming appended — nothing
/// else in the user's exclude file is touched (byte-faithful removal lives
/// in `keepdeck_git::exclude`).
fn remove_excluded(armed_root: &Path) -> io::Result<()> {
    match agents_exclusion(armed_root)? {
        Some((common_dir, line)) => keepdeck_git::exclude::remove_line(&common_dir, &line),
        None => Ok(()),
    }
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

/// Idempotently append the armed dir's anchored line to the owning repo's
/// SHARED `info/exclude` so it never shows up in git status or a commit
/// (resolution and the byte-faithful edit live in `keepdeck_git::exclude`).
fn ensure_excluded(armed_root: &Path) -> io::Result<()> {
    match agents_exclusion(armed_root)? {
        Some((common_dir, line)) => keepdeck_git::exclude::ensure_line(&common_dir, &line),
        None => Ok(()),
    }
}

/// The owning repo's COMMON git dir plus the anchored `.agents` ignore
/// pattern for an armed cwd — `/.agents/` at the repo root,
/// `/<subdir>/.agents/` below it (forward slashes on every platform: the
/// pattern is git syntax) — or `None` when no ancestor is a git checkout.
/// This module knows only the `.agents` pattern; the git plumbing is
/// `keepdeck_git::exclude`'s.
fn agents_exclusion(armed_root: &Path) -> io::Result<Option<(PathBuf, String)>> {
    let Some(repo) = keepdeck_git::exclude::owning_repo(armed_root)? else {
        return Ok(None);
    };
    let line = if repo.below_root.is_empty() {
        "/.agents/".to_string()
    } else {
        format!("/{}/.agents/", repo.below_root)
    };
    Ok(Some((repo.common_dir, line)))
}

/// `.tmp-<id>`/`.old-<id>` build leftovers follow the same liveness rule as
/// the dirs themselves, so an in-flight stage of a LIVE workspace can never
/// lose its build-aside dir to a concurrent prune. Dead workspaces' armed
/// manifests are consumed here too: their recorded spawn cwds get OUR
/// symlinks removed — the crash path, where the deck no longer knows the
/// workspace but its worktrees survived.
fn prune(root: &Path, live: &[String]) -> io::Result<()> {
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
            // abort the sweep before the manifest disarms below run.
            if let Err(e) = fs::remove_dir_all(&dir) {
                log::warn!("skills: pruning {} failed: {e}", dir.display());
            }
        }
    }
    let manifests = match fs::read_dir(root.join("armed")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in manifests.flatten() {
        let ws = entry.file_name().to_string_lossy().into_owned();
        if live.iter().any(|l| l == &ws) {
            continue;
        }
        // A manifest that won't parse is EVIDENCE of armed cwds we can no
        // longer locate — keep it (and warn) rather than silently deleting
        // the only record; a later fixed pass may still act on it.
        let Some(roots) = fs::read(entry.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        else {
            log::warn!(
                "skills: armed manifest for {ws} is unreadable — kept, not disarmed",
            );
            continue;
        };
        // A cwd another workspace still claims keeps its symlink — two
        // workspaces on one folder must not lose arming because one died.
        let claimed = claimed_by_others(root, &ws);
        let ours: Vec<String> = roots.into_iter().filter(|r| !claimed.contains(r)).collect();
        if let Err(e) = disarm_roots(root, &ours) {
            log::warn!("skills: disarming dead workspace {ws} failed: {e}");
        }
        let _ = fs::remove_file(entry.path());
    }
    Ok(())
}

/// The generated `/name` command for opencode: it surfaces no skill listing
/// or slash form of its own, so each skill doubles as a palette command
/// whose description is the skill's own, pointing the agent at the staged
/// SKILL.md (a reference, not a copy of the body — it cannot go stale).
fn opencode_command(name: &str, content: &str, staged_skill: &Path) -> String {
    let description = frontmatter_line(content, "description").unwrap_or_default();
    format!(
        "---\ndescription: {description}\n---\nUse the \"{name}\" skill: read {} and follow its \
         instructions for this request: $ARGUMENTS\n",
        staged_skill.display(),
    )
}

/// Best-effort raw value of one `key:` line inside the frontmatter fence.
/// Schema knowledge stays TS-side — this lifts a line the library already
/// stores as valid YAML and re-emits it VERBATIM (quoting untouched).
/// COUPLING PIN: this depends on descriptions being single-line, which
/// only the TS side enforces (`isValidSkillDescription`,
/// src/domain/skills/skills.ts). If TS ever allows multi-line or block
/// scalars, this lift breaks — the pin test below and the note on the TS
/// validator mark the contract on both sides.
fn frontmatter_line(content: &str, key: &str) -> Option<String> {
    // CRLF-tolerant like the TS parser (the coupling pin's other side): a
    // hand-edited Windows-style file must not lose its description here.
    let normalized = content.replace("\r\n", "\n");
    let rest = normalized.strip_prefix("---\n")?;
    let fence = rest.find("\n---\n")?;
    rest[..fence].lines().find_map(|line| {
        line.strip_prefix(key)?
            .strip_prefix(':')
            .map(|value| value.trim().to_string())
    })
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
    fn rename_moves_the_whole_directory_and_refuses_collisions() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "content").unwrap();
        fs::write(global(&root).join("review").join("notes.txt"), "asset").unwrap();
        save(&global(&root), "deploy", "other").unwrap();

        rename(&global(&root), "review", "deep-review").unwrap();
        let moved = global(&root).join("deep-review");
        assert_eq!(fs::read_to_string(moved.join(SKILL_FILE)).unwrap(), "content");
        assert_eq!(fs::read_to_string(moved.join("notes.txt")).unwrap(), "asset");
        assert!(!global(&root).join("review").exists());

        // Onto an existing skill — refused, both survive untouched.
        assert!(rename(&global(&root), "deep-review", "deploy").is_err());
        assert!(moved.exists());
        assert_eq!(
            fs::read_to_string(global(&root).join("deploy").join(SKILL_FILE)).unwrap(),
            "other",
        );
        assert!(rename(&global(&root), "deep-review", "../up").is_err());
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
    fn arms_a_plain_main_checkout_cwd() {
        let (_tmp, root) = root();
        let repo = root.parent().unwrap().join("checkout");
        fs::create_dir_all(repo.join(".git")).unwrap();
        save(&global(&root), "review", "x").unwrap();

        stage(&SkillsLocks::default(), &root, "ws-1", &[repo.to_string_lossy().into_owned()])
            .unwrap()
            .unwrap();

        let link = repo.join(".agents").join("skills");
        assert!(link.join("review").join(SKILL_FILE).exists());
        let exclude =
            fs::read_to_string(repo.join(".git").join("info").join("exclude")).unwrap();
        assert!(exclude.contains("/.agents/"));
    }

    #[test]
    fn a_subdir_cwd_is_armed_with_an_anchored_exclude_in_the_owning_repo() {
        let (_tmp, root) = root();
        let repo = root.parent().unwrap().join("checkout");
        let cwd = repo.join("packages").join("app");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        save(&global(&root), "review", "x").unwrap();

        stage(&SkillsLocks::default(), &root, "ws-1", &[cwd.to_string_lossy().into_owned()])
            .unwrap()
            .unwrap();

        // The link sits AT the cwd (codex reads its starting cwd first),
        // and the exclude anchors that exact path in the repo's exclude.
        assert!(cwd.join(".agents").join("skills").join("review").exists());
        let exclude =
            fs::read_to_string(repo.join(".git").join("info").join("exclude")).unwrap();
        assert!(exclude.lines().any(|l| l == "/packages/app/.agents/"));
    }

    #[test]
    fn a_users_real_agents_dir_is_never_touched() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        let theirs = wt.join(".agents").join("skills");
        fs::create_dir_all(theirs.join("their-skill")).unwrap();
        save(&global(&root), "review", "x").unwrap();

        let roots = vec![wt.to_string_lossy().into_owned()];
        stage(&SkillsLocks::default(), &root, "ws-1", &roots).unwrap().unwrap();
        assert!(theirs.join("their-skill").exists());
        assert!(!fs::symlink_metadata(&theirs).unwrap().file_type().is_symlink());

        // Emptying the library leaves it alone too.
        delete(&global(&root), "review").unwrap();
        assert_eq!(stage(&SkillsLocks::default(), &root, "ws-1", &roots).unwrap(), None);
        assert!(theirs.join("their-skill").exists());
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

        disarm_roots(&root, &[wt.to_string_lossy().into_owned()]).unwrap();
        assert!(agents.join("skills").exists());
        assert!(agents.join("notes.txt").exists());
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
    fn a_dot_agents_file_or_user_symlink_is_skipped_without_failing_stage() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "x").unwrap();
        let base = root.parent().unwrap();

        // `.agents` is a regular FILE — not ours, and not fatal.
        let with_file = base.join("cwd-file");
        fs::create_dir_all(&with_file).unwrap();
        fs::write(with_file.join(".agents"), "not a dir").unwrap();

        // `.agents` is the user's SYMLINK to their own directory — writing
        // through it would land inside their tree.
        let with_link = base.join("cwd-link");
        let their_tree = base.join("their-agents");
        fs::create_dir_all(&with_link).unwrap();
        fs::create_dir_all(&their_tree).unwrap();
        symlink_dir(&their_tree, &with_link.join(".agents")).unwrap();

        let roots = vec![
            with_file.to_string_lossy().into_owned(),
            with_link.to_string_lossy().into_owned(),
        ];
        stage(&SkillsLocks::default(), &root, "ws-1", &roots).unwrap().unwrap(); // no error
        assert_eq!(fs::read_to_string(with_file.join(".agents")).unwrap(), "not a dir");
        assert!(!their_tree.join("skills").exists()); // nothing planted in their tree
    }

    #[test]
    fn disarm_removes_the_exclude_line_and_keeps_the_users_lines() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        let exclude = root
            .parent()
            .unwrap()
            .join("main")
            .join(".git")
            .join("info")
            .join("exclude");
        fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        fs::write(&exclude, "*.log\n").unwrap();
        save(&global(&root), "review", "x").unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];
        stage(&SkillsLocks::default(), &root, "ws-1", &roots).unwrap().unwrap();
        assert!(fs::read_to_string(&exclude).unwrap().contains("/.agents/"));

        disarm_roots(&root, &roots).unwrap();
        let text = fs::read_to_string(&exclude).unwrap();
        assert!(!text.contains("/.agents/"));
        assert!(text.contains("*.log")); // the user's own line survives
    }

    #[test]
    fn disarm_preserves_a_crlf_exclude_files_bytes() {
        // TRAP for the inline lines()+join removal this module once had: a
        // CRLF exclude file must keep every carriage return through an
        // arm/disarm cycle — only OUR line goes.
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        let exclude = root
            .parent()
            .unwrap()
            .join("main")
            .join(".git")
            .join("info")
            .join("exclude");
        fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        fs::write(&exclude, "# mine\r\n*.log\r\n").unwrap();
        save(&global(&root), "review", "x").unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];
        stage(&SkillsLocks::default(), &root, "ws-1", &roots).unwrap().unwrap();

        disarm_roots(&root, &roots).unwrap();
        let text = fs::read_to_string(&exclude).unwrap();
        assert!(!text.contains("/.agents/"));
        assert!(text.starts_with("# mine\r\n*.log\r\n"), "CRLF mangled: {text:?}");
    }

    #[test]
    fn prune_spares_a_cwd_a_surviving_workspace_still_claims() {
        let (_tmp, root) = root();
        let shared = root.parent().unwrap().join("shared-cwd");
        fs::create_dir_all(&shared).unwrap();
        save(&global(&root), "review", "x").unwrap();
        let roots = vec![shared.to_string_lossy().into_owned()];
        let locks = SkillsLocks::default();
        stage(&locks, &root, "ws-live", &roots).unwrap().unwrap();
        stage(&locks, &root, "ws-dead", &roots).unwrap().unwrap();

        // ws-dead crashed; ws-live still runs panes in the shared cwd. The
        // LINK survives (symlink_metadata, not exists(): the shared link
        // last pointed at ws-dead's now-pruned staging, so it dangles until
        // ws-live's next stage re-aims it — the documented staleness model).
        prune(&root, &["ws-live".into()]).unwrap();
        assert!(fs::symlink_metadata(shared.join(".agents").join("skills")).is_ok());
        assert!(!armed_manifest(&root, "ws-dead").exists());
        assert!(armed_manifest(&root, "ws-live").exists());

        // And ws-live's next stage re-aims the surviving link at ITS view.
        let views = stage(&locks, &root, "ws-live", &roots).unwrap().unwrap();
        assert_eq!(
            fs::read_link(shared.join(".agents").join("skills")).unwrap(),
            PathBuf::from(&views.skills_dir),
        );
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
    fn an_unreadable_armed_manifest_is_kept_as_evidence() {
        let (_tmp, root) = root();
        fs::create_dir_all(root.join("armed")).unwrap();
        fs::write(root.join("armed").join("ws-dead"), "not json").unwrap();

        prune(&root, &["ws-1".into()]).unwrap();
        assert!(root.join("armed").join("ws-dead").exists());
    }

    #[test]
    fn prune_disarms_a_crashed_workspaces_recorded_cwds() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        save(&global(&root), "review", "x").unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];
        stage(&SkillsLocks::default(), &root, "ws-9", &roots).unwrap().unwrap();
        assert!(wt.join(".agents").join("skills").exists());

        // Boot after a crash: ws-9 is not in the restored deck.
        prune(&root, &["ws-1".into()]).unwrap();
        assert!(!wt.join(".agents").exists());
        assert!(!armed_manifest(&root, "ws-9").exists());
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
    fn frontmatter_lift_is_verbatim_and_single_line_pinned() {
        // COUPLING PIN with src/domain/skills/skills.ts: descriptions are
        // single-line (TS enforces) and the lift re-emits the scalar
        // VERBATIM, quoting untouched.
        let content = "---\nname: x\ndescription: \"Use when: it's risky\"\n---\nB\n";
        assert_eq!(
            frontmatter_line(content, "description").as_deref(),
            Some("\"Use when: it's risky\""),
        );
        let command = opencode_command("x", content, Path::new("/staged/SKILL.md"));
        assert!(command.starts_with("---\ndescription: \"Use when: it's risky\"\n---\n"));

        // CRLF row of the pin: the lift must read Windows-style files the
        // way the TS parser does, not return an empty description.
        let crlf = "---\r\nname: x\r\ndescription: Ships it\r\n---\r\nB\r\n";
        assert_eq!(frontmatter_line(crlf, "description").as_deref(), Some("Ships it"));
    }

    #[test]
    fn prune_drops_dead_workspaces_and_spares_live_ones_and_the_library() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "x").unwrap();
        save(&ws(&root, "ws-dead"), "gone", "x").unwrap();
        stage(&SkillsLocks::default(), &root, "ws-live", &[]).unwrap().unwrap();
        stage(&SkillsLocks::default(), &root, "ws-dead", &[]).unwrap().unwrap();
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

        let views = stage(&SkillsLocks::default(), &root, "ws-1", &[]).unwrap().unwrap();
        let skills = PathBuf::from(&views.skills_dir);
        assert!(skills.join("mine").exists());
        assert!(!skills.join("theirs").exists());
    }
}
