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
mod bundled;
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
    library::list(&skills_root()?, bundled::BUNDLED).map_err(|e| e.to_string())
}

/// The refusal rule's shared arm-check (design §4): a mutation naming a
/// BUNDLED skill is decided by WHICH ROW EXISTS, here Rust-side — the
/// raw-IPC layer has no row check of its own (the TS door's refusal
/// alone leaks). Returns the tier's names for the caller's arm logic.
fn bundled_names() -> impl Iterator<Item = &'static str> {
    bundled::BUNDLED.iter().map(|skill| skill.name)
}

/// The teaching refusal for a bundled name with no library row — the
/// sentence names the shadow path, so it teaches rather than blocks.
fn bundled_teaching(name: &str) -> String {
    format!(
        "a bundled skill ships with the name {name:?} — create your own; \
         the same name will shadow the bundled one for agents"
    )
}

/// The three-arms gate for a mutation addressing `name` in one library
/// scope. Arm 1: the user's row exists → normal CRUD (the bundled twin
/// notwithstanding). Arm 2: no row + a bundled name → the teaching
/// refusal (nothing of ours is editable). Arm 3 is the caller's
/// (create) — it SUCCEEDS with a bundled name: the blessed shadow.
fn bundled_arm_check(dir: &std::path::Path, name: &str) -> Result<(), String> {
    let row_exists = dir.join(name).join(library::SKILL_FILE).exists();
    if row_exists {
        return Ok(());
    }
    if bundled_names().any(|bundled| bundled == name) {
        return Err(bundled_teaching(name));
    }
    Ok(())
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
    if scope == "bundled" {
        // The tier has no directory to write — the teaching text points
        // at the copy-into-your-own flow (a scope:'bundled' ARGUMENT is
        // always a door error, whatever the arms say about names).
        return Err(
            "bundled skills ship with KeepDeck and update with it — create your own in Global (the text is selectable, copy any part)".into(),
        );
    }
    let dir = library::scope_dir(&root, &scope, ws_id.as_deref())?;
    if expect_new {
        // Arm 3: create with a bundled name SUCCEEDS — the shadow path.
        library::create(&dir, &name, &content).map_err(|e| e.to_string())
    } else {
        // Arms 1/2 for updates: the row-existence check, THEN the save
        // (the Rust save is an upsert with no row check of its own —
        // without the gate a raw IPC update on a bundled name silently
        // creates the shadow it should have refused to edit).
        bundled_arm_check(&dir, &name)?;
        library::save(&dir, &name, &content).map_err(|e| e.to_string())
    }
}

/// Remove one skill's directory entirely (assets included). Missing is fine.
#[tauri::command(async)]
pub fn skills_delete(scope: String, ws_id: Option<String>, name: String) -> Result<(), String> {
    let root = skills_root()?;
    if scope == "bundled" {
        return Err(
            "bundled skills ship with KeepDeck and update with it — nothing to delete here".into(),
        );
    }
    let dir = library::scope_dir(&root, &scope, ws_id.as_deref())?;
    bundled_arm_check(&dir, &name)?;
    library::delete(&dir, &name).map_err(|e| e.to_string())
}

/// Rename one skill by moving its whole directory — assets travel with it,
/// which a save-new-delete-old dance would silently drop. Refuses to move
/// onto an existing skill. The bundled-name matrix (design §4): rename
/// FROM an absent bundled name is arm 2 (nothing of ours to move);
/// rename ONTO a bundled name is an authoring act — any-free-name
/// semantics, SUCCEEDS (create-consistent; refusing it while create
/// succeeds is the door-slam class).
#[tauri::command(async)]
pub fn skills_rename(
    scope: String,
    ws_id: Option<String>,
    from: String,
    to: String,
) -> Result<(), String> {
    let root = skills_root()?;
    if scope == "bundled" {
        return Err(
            "bundled skills ship with KeepDeck and update with it — nothing to rename here".into(),
        );
    }
    let dir = library::scope_dir(&root, &scope, ws_id.as_deref())?;
    bundled_arm_check(&dir, &from)?;
    library::rename(&dir, &from, &to).map_err(|e| e.to_string())
}

/// Rebuild and return the staged views for one workspace — `None` when the
/// library holds nothing for it (callers then inject no skills at all).
/// `roots` are the workspace's pane spawn cwds: each gets the codex-facing
/// `.agents/skills` symlink armed (or disarmed when empty).
#[tauri::command(async)]
pub fn skills_stage(
    locks: tauri::State<'_, SkillsLocks>,
    artifacts: tauri::State<'_, crate::artifacts::ArtifactsState>,
    ws_id: String,
    roots: Vec<String>,
) -> Result<Option<SkillStagingDto>, String> {
    let root = skills_root()?;
    library::require_safe(&ws_id, "workspace id")?;
    // The SOLE artifacts-importing site in skills (the glue): the claim
    // probe resolves to a plain bool here, and staging logic downstream
    // stays artifacts-free — content obeys the same gate as its tools.
    let claimed = artifacts.is_claimed();
    staging::stage(&locks, &root, &ws_id, &roots, bundled::BUNDLED, claimed)
        .map_err(|e| e.to_string())
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
        staging::stage(&locks, &root, "ws-live", &roots, &[], false).unwrap().unwrap();
        staging::stage(&locks, &root, "ws-dead", &roots, &[], false).unwrap().unwrap();

        // ws-dead crashed; ws-live still runs panes in the shared cwd. The
        // LINK survives (symlink_metadata, not exists(): the shared link
        // last pointed at ws-dead's now-pruned staging, so it dangles until
        // ws-live's next stage re-aims it — the documented staleness model).
        prune(&root, &["ws-live".into()]).unwrap();
        assert!(fs::symlink_metadata(shared.join(".agents").join("skills")).is_ok());
        assert!(!armed_manifest(&root, "ws-dead").exists());
        assert!(armed_manifest(&root, "ws-live").exists());

        // And ws-live's next stage re-aims the surviving link at ITS view.
        let views = staging::stage(&locks, &root, "ws-live", &roots, &[], false).unwrap().unwrap();
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
        staging::stage(&SkillsLocks::default(), &root, "ws-9", &roots, &[], false).unwrap().unwrap();
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

    // ---- the refusal rule's three arms (design §4) + the bundled
    // staging half (both views AND the opencode command) ----
    //
    // The arm tests call the real COMMANDS, which resolve skills_root()
    // from KEEPDECK_HOME — the env override IS the isolation (the real
    // home may carry a user-authored artifacts skill: the day-one
    // shadow, which would turn arm 3's create into a collision). The
    // env is PROCESS-GLOBAL: the lock serializes the tests that touch
    // it, so two isolated_homes never race one home over another.
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn isolated_home(tag: &str) -> (std::sync::MutexGuard<'static, ()>, tempfile::TempDir) {
        let guard = HOME_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("KEEPDECK_HOME", dir.path().join(tag));
        (guard, dir)
    }

    #[test]
    fn tier_entries_materialize_identically_command_included() {
        // The F-R1 pin: a bundled skill produces ALL views AND the
        // opencode palette command — identically to a library skill.
        let (_tmp, root) = root();
        let tier = [crate::skills::bundled::BundledSkill {
            name: "probe",
            content: "---\nname: probe\ndescription: \"Probe: the tier\"\n---\nBody\n",
            gated: false,
        }];
        let views = staging::stage(
            &SkillsLocks::default(),
            &root,
            "ws-1",
            &[],
            &tier,
            false,
        )
        .unwrap()
        .unwrap();
        // All three views carry the skill.
        for dir in [
            PathBuf::from(&views.claude_plugin_dir).join("skills"),
            PathBuf::from(&views.skills_dir),
            PathBuf::from(&views.opencode_config_dir).join("skills"),
        ] {
            assert!(dir.join("probe").join(library::SKILL_FILE).exists());
        }
        // The palette command exists and its description comes from the
        // constant's frontmatter, pointing at the staged SKILL.md.
        let command = std::fs::read_to_string(
            PathBuf::from(&views.opencode_config_dir)
                .join("command")
                .join("probe.md"),
        )
        .unwrap();
        assert!(
            command.starts_with("---\ndescription: \"Probe: the tier\"\n---"),
            "the command's description is the constant's own (frontmatter lifted verbatim, quoting intact): {command}"
        );
        assert!(command.contains("skills/probe/SKILL.md"));
    }

    #[test]
    fn the_three_refusal_arms_rust_side() {
        let (_guard, _home) = isolated_home("arms");
        std::fs::create_dir_all(skills_root().unwrap().join("library").join("global")).unwrap();
        let global_dir = skills_root().unwrap().join("library").join("global");

        // Arm 3: CREATE with a bundled name SUCCEEDS — the blessed shadow.
        skills_save(
            "global".into(),
            None,
            "artifacts".into(),
            "user's own copy".into(),
            true,
        )
        .unwrap();
        assert!(global_dir.join("artifacts").join(library::SKILL_FILE).exists());

        // Arm 1: UPDATE on the existing (user) row → normal CRUD.
        skills_save(
            "global".into(),
            None,
            "artifacts".into(),
            "edited".into(),
            false,
        )
        .unwrap();

        // Arm 2: DELETE (the row exists) → normal CRUD; then a second
        // delete (row ABSENT, bundled name) → the teaching refusal.
        skills_delete("global".into(), None, "artifacts".into()).unwrap();
        let refusal = skills_delete("global".into(), None, "artifacts".into())
            .unwrap_err();
        assert!(
            refusal.contains("bundled skill ships with the name"),
            "the teaching refusal names the shadow path: {refusal}"
        );

        // The upsert hole stays closed: an UPDATE on an absent bundled
        // name refuses rather than silently creating a row.
        let upsert = skills_save(
            "global".into(),
            None,
            "artifacts".into(),
            "sneaky shadow".into(),
            false,
        )
        .unwrap_err();
        assert!(upsert.contains("bundled skill ships with the name"));
        assert!(
            !global_dir.join("artifacts").join(library::SKILL_FILE).exists(),
            "no row was silently created"
        );
    }

    #[test]
    fn the_rename_matrix_for_bundled_names() {
        let (_guard, _home) = isolated_home("rename");
        std::fs::create_dir_all(skills_root().unwrap().join("library").join("global")).unwrap();
        let global_dir = skills_root().unwrap().join("library").join("global");
        library::save(&global_dir, "mine", "content").unwrap();

        // Rename ONTO a bundled name (absent target): an authoring act —
        // SUCCEEDS (any-free-name semantics, visible in the list).
        skills_rename("global".into(), None, "mine".into(), "artifacts".into())
            .unwrap();
        assert!(global_dir.join("artifacts").join(library::SKILL_FILE).exists());
        assert!(!global_dir.join("mine").exists());

        // Rename FROM an absent bundled name → arm 2 teaching refusal.
        library::delete(&global_dir, "artifacts").unwrap();
        library::save(&global_dir, "other", "content").unwrap();
        let refusal = skills_rename(
            "global".into(),
            None,
            "artifacts".into(),
            "other".into(),
        )
        .unwrap_err();
        assert!(refusal.contains("bundled skill ships with the name"));
    }

    #[test]
    fn a_bundled_scope_argument_refuses_with_the_teaching_text() {
        let refusal = skills_save(
            "bundled".into(),
            None,
            "anything".into(),
            "content".into(),
            true,
        )
        .unwrap_err();
        assert!(
            refusal.contains("bundled skills ship with KeepDeck"),
            "the scope argument refuses with the copy-into-your-own teaching: {refusal}"
        );
        let del = skills_delete("bundled".into(), None, "anything".into()).unwrap_err();
        assert!(del.contains("bundled skills ship with KeepDeck"));
        let ren = skills_rename(
            "bundled".into(),
            None,
            "a".into(),
            "b".into(),
        )
        .unwrap_err();
        assert!(ren.contains("bundled skills ship with KeepDeck"));
    }
}
