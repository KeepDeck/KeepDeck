//! The shared skills feature: its command surface and the app state it needs.
//!
//! KeepDeck-authored agent skills (the open SKILL.md format) live under
//! KeepDeck's own home — never inside a repo and never in any CLI's dotfiles:
//!
//! - `<keepdeck_home>/skills/library/global/<skill>/SKILL.md`
//! - `<keepdeck_home>/skills/library/ws/<wsId>/<skill>/SKILL.md`
//!
//! The work itself lives one level down, each half in its own module:
//!
//! - [`library`] — what the user authored: listing, saving, renaming, and the
//!   path-segment safety every name goes through
//! - [`staging`] — the derived per-workspace views a spawning CLI is pointed
//!   at, rebuilt from scratch on every request
//! - [`opencode`] — the generated palette command that makes a staged skill
//!   user-visible in opencode
//! - [`arming`] — the `.agents/skills` symlink codex reads from a pane's cwd,
//!   and the manifest that lets a crashed workspace be disarmed at boot
//!
//! Frontmatter and schema knowledge stay in TS (`src/domain/skills`), next to
//! the model; this adapter moves bytes — list, save, delete, stage — plus ONE
//! pinned single-line exception in [`opencode`] (coupling pinned on both
//! language sides).

mod arming;
mod library;
mod opencode;
mod staging;

use std::io;
use std::path::{Path, PathBuf};

// Re-exported for the command signatures below and for `lib.rs`'s managed
// state; each shape is DEFINED beside the code that produces it, so a change
// to staging's views or the library's wire shape lands in one file rather
// than reaching up into this router.
pub use library::SkillDto;
pub use staging::{SkillStagingDto, SkillsLocks};

/// Every skill in the library, global scope first, then workspaces, names
/// alphabetical — a deterministic order the UI can render as-is.
#[tauri::command(async)]
pub fn skills_list() -> Result<Vec<SkillDto>, String> {
    library::list(&skills_root()?).map_err(|e| e.to_string())
}

/// Write one skill's `SKILL.md` (content is composed and validated by the
/// webview; this side refuses unsafe path segments — and, when the caller says
/// this is a CREATE, a name that is already taken).
#[tauri::command(async)]
pub fn skills_save(
    scope: String,
    ws_id: Option<String>,
    name: String,
    content: String,
    expect_new: bool,
) -> Result<(), String> {
    let root = skills_root()?;
    let dir = library::scope_dir(&root, &scope, ws_id.as_deref())?;
    if expect_new {
        library::create(&dir, &name, &content).map_err(|e| e.to_string())
    } else {
        library::save(&dir, &name, &content).map_err(|e| e.to_string())
    }
}

/// Remove one skill's directory entirely (assets included). Missing is fine.
#[tauri::command(async)]
pub fn skills_delete(scope: String, ws_id: Option<String>, name: String) -> Result<(), String> {
    let root = skills_root()?;
    let dir = library::scope_dir(&root, &scope, ws_id.as_deref())?;
    library::delete(&dir, &name).map_err(|e| e.to_string())
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
    let dir = library::scope_dir(&root, &scope, ws_id.as_deref())?;
    library::rename(&dir, &from, &to).map_err(|e| e.to_string())
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
    library::require_safe(&ws_id, "workspace id")?;
    staging::stage(&locks, &root, &ws_id, &roots).map_err(|e| e.to_string())
}

/// Remove KeepDeck's `.agents/skills` symlinks from the given spawn cwds —
/// a closing workspace's directories must not keep dangling links once its
/// staging is pruned. Only provably-ours links are touched.
#[tauri::command(async)]
pub fn skills_disarm(roots: Vec<String>) -> Result<(), String> {
    let root = skills_root()?;
    arming::disarm_roots(&root, &roots).map_err(|e| e.to_string())
}

/// Drop what workspaces that no longer exist left behind: their derived
/// views, and the cwds their armed manifests still record (the crash path —
/// the deck no longer knows the workspace but its worktrees survived). The
/// library is user content and is never touched here.
#[tauri::command(async)]
pub fn skills_prune(live_ws_ids: Vec<String>) -> Result<(), String> {
    prune(&skills_root()?, &live_ws_ids).map_err(|e| e.to_string())
}

fn prune(root: &Path, live: &[String]) -> io::Result<()> {
    staging::prune_views(root, live)?;
    arming::prune_armed(root, live)
}

fn skills_root() -> Result<PathBuf, String> {
    let home = crate::paths::keepdeck_home().ok_or("no home directory for skills")?;
    Ok(home.join("skills"))
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A skills root inside a temp dir. The `TempDir` is returned so the
    /// caller keeps it alive for the length of the test.
    pub(crate) fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("skills");
        (dir, root)
    }

    pub(crate) fn global(root: &Path) -> PathBuf {
        root.join("library").join("global")
    }

    pub(crate) fn ws(root: &Path, id: &str) -> PathBuf {
        root.join("library").join("ws").join(id)
    }

    /// A fake linked-worktree checkout: `main/.git/` (common dir) plus a
    /// worktree whose `.git` FILE points at `main/.git/worktrees/wt` with a
    /// `commondir` back-pointer — the layout `git worktree add` produces,
    /// built by hand so the test needs no git binary.
    pub(crate) fn fake_worktree(base: &Path) -> PathBuf {
        let common = base.join("main").join(".git");
        let gitdir = common.join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        wt
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{fake_worktree, global, root};
    use super::*;
    use crate::worktree_arm::armed_manifest;
    use crate::skills::library::save;
    use std::fs;

    #[test]
    fn prune_spares_a_cwd_a_surviving_workspace_still_claims() {
        let (_tmp, root) = root();
        let shared = root.parent().unwrap().join("shared-cwd");
        fs::create_dir_all(&shared).unwrap();
        save(&global(&root), "review", "x").unwrap();
        let roots = vec![shared.to_string_lossy().into_owned()];
        let locks = SkillsLocks::default();
        staging::stage(&locks, &root, "ws-live", &roots).unwrap().unwrap();
        staging::stage(&locks, &root, "ws-dead", &roots).unwrap().unwrap();

        // ws-dead crashed; ws-live still runs panes in the shared cwd. The
        // LINK survives (symlink_metadata, not exists(): the shared link
        // last pointed at ws-dead's now-pruned staging, so it dangles until
        // ws-live's next stage re-aims it — the documented staleness model).
        prune(&root, &["ws-live".into()]).unwrap();
        assert!(fs::symlink_metadata(shared.join(".agents").join("skills")).is_ok());
        assert!(!armed_manifest(&root, "ws-dead").exists());
        assert!(armed_manifest(&root, "ws-live").exists());

        // And ws-live's next stage re-aims the surviving link at ITS view.
        let views = staging::stage(&locks, &root, "ws-live", &roots).unwrap().unwrap();
        assert_eq!(
            fs::read_link(shared.join(".agents").join("skills")).unwrap(),
            PathBuf::from(&views.skills_dir),
        );
    }

    #[test]
    fn prune_disarms_a_crashed_workspaces_recorded_cwds() {
        let (_tmp, root) = root();
        let wt = fake_worktree(root.parent().unwrap());
        save(&global(&root), "review", "x").unwrap();
        let roots = vec![wt.to_string_lossy().into_owned()];
        staging::stage(&SkillsLocks::default(), &root, "ws-9", &roots).unwrap().unwrap();
        assert!(wt.join(".agents").join("skills").exists());

        // Boot after a crash: ws-9 is not in the restored deck.
        prune(&root, &["ws-1".into()]).unwrap();
        assert!(!wt.join(".agents").exists());
        assert!(!armed_manifest(&root, "ws-9").exists());
    }

    #[test]
    fn prune_on_a_fresh_home_is_a_no_op() {
        let (_tmp, root) = root();
        prune(&root, &["ws-1".into()]).unwrap();
    }
}
