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
//! - [`staging`] — the per-workspace skills a spawning agent is handed,
//!   rebuilt from scratch on every request, and how much of them fits
//! - [`tree`] — what of a skill's folder an agent may be handed at all: read
//!   beneath the folder, no link out of it, nothing waited on
//!
//! Frontmatter and schema knowledge stay in TS (the SKILL.md codec in
//! plugin-api), next to the model; this adapter moves bytes — list, save,
//! delete, stage. What a CLI needs built from the staged skills, or planted
//! in a pane's cwd to find them, is its plugin's.

mod bundled;
mod fingerprint;
mod gates;
mod library;
mod staging;
mod tree;

use crate::forgotten::{Gate, Source};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// Re-exported for the command signatures below and for `lib.rs`'s managed
// state; each shape is DEFINED beside the code that produces it, so a change
// to staging's views or the library's wire shape lands in one file rather
// than reaching up into this router.
pub use library::SkillDto;
pub(crate) use library::require_safe;
pub use staging::{SkillsLocks, StagingAnswer};
pub(crate) use bundled::BUNDLED;
pub(crate) use gates::{GateKey, GateRegistry};

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

/// The one lock every write into the library takes — the MCP library's
/// twin: a create's "is it there" and its write, a rename's collision check
/// and its move, are two steps each, and two agents' commands land on one
/// directory at once.
#[derive(Default)]
pub struct SkillsLibraryLock(Mutex<()>);

/// The library as its commands write it: its lock, the commit gate, its
/// root. `writer` throughout: the agent writing, as the app knows it; none
/// for the person.
struct Library<'a> {
    lock: &'a SkillsLibraryLock,
    gate: &'a Gate,
    root: &'a Path,
}

impl Library<'_> {
    /// One write into a scope: under the library's lock, the commit gate
    /// asked first — a closed agent writes nowhere, and a forgotten
    /// workspace's scope takes nothing more.
    fn write_in(
        &self,
        writer: Option<&Source>,
        scope: &str,
        ws_id: Option<&str>,
        write: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        self.gate.write_under(&self.lock.0, writer, ws_id, || write(&library::scope_dir(self.root, scope, ws_id)?))
    }

    fn save(&self, writer: Option<&Source>, scope: &str, ws_id: Option<&str>, name: &str, content: &str, expect_new: bool) -> Result<(), String> {
        if scope == "bundled" {
            // The tier has no directory to write — the teaching text points
            // at the copy-into-your-own flow (a scope:'bundled' ARGUMENT is
            // always a door error, whatever the arms say about names).
            return Err(
                "bundled skills ship with KeepDeck and update with it — create your own in Global (the text is selectable, copy any part)".into(),
            );
        }
        self.write_in(writer, scope, ws_id, |dir| {
            if expect_new {
                // Arm 3: create with a bundled name SUCCEEDS — the shadow path.
                library::create(dir, name, content).map_err(|e| e.to_string())
            } else {
                // Arms 1/2 for updates: the row-existence check, THEN the save
                // (the Rust save is an upsert with no row check of its own —
                // without the gate a raw IPC update on a bundled name silently
                // creates the shadow it should have refused to edit).
                bundled_arm_check(dir, name)?;
                library::save(dir, name, content).map_err(|e| e.to_string())
            }
        })
    }

    fn delete(&self, writer: Option<&Source>, scope: &str, ws_id: Option<&str>, name: &str) -> Result<(), String> {
        if scope == "bundled" {
            return Err(
                "bundled skills ship with KeepDeck and update with it — nothing to delete here".into(),
            );
        }
        self.write_in(writer, scope, ws_id, |dir| {
            bundled_arm_check(dir, name)?;
            library::delete(dir, name).map_err(|e| e.to_string())
        })
    }

    fn rename(&self, writer: Option<&Source>, scope: &str, ws_id: Option<&str>, from: &str, to: &str) -> Result<(), String> {
        if scope == "bundled" {
            return Err(
                "bundled skills ship with KeepDeck and update with it — nothing to rename here".into(),
            );
        }
        self.write_in(writer, scope, ws_id, |dir| {
            bundled_arm_check(dir, from)?;
            library::rename(dir, from, to).map_err(|e| e.to_string())
        })
    }
}

/// Write one skill's `SKILL.md` (content is composed and validated by the
/// webview; this side refuses unsafe path segments — and, when the caller says
/// this is a CREATE, a name that is already taken).
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn skills_save(
    lock: tauri::State<'_, SkillsLibraryLock>,
    gate: tauri::State<'_, Gate>,
    writer: Option<Source>,
    scope: String,
    ws_id: Option<String>,
    name: String,
    content: String,
    expect_new: bool,
) -> Result<(), String> {
    let root = skills_root()?;
    Library { lock: &lock, gate: &gate, root: &root }.save(writer.as_ref(), &scope, ws_id.as_deref(), &name, &content, expect_new)
}

/// Remove one skill's directory entirely (assets included). Missing is fine.
#[tauri::command(async)]
pub fn skills_delete(
    lock: tauri::State<'_, SkillsLibraryLock>,
    gate: tauri::State<'_, Gate>,
    writer: Option<Source>,
    scope: String,
    ws_id: Option<String>,
    name: String,
) -> Result<(), String> {
    let root = skills_root()?;
    Library { lock: &lock, gate: &gate, root: &root }.delete(writer.as_ref(), &scope, ws_id.as_deref(), &name)
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
    lock: tauri::State<'_, SkillsLibraryLock>,
    gate: tauri::State<'_, Gate>,
    writer: Option<Source>,
    scope: String,
    ws_id: Option<String>,
    from: String,
    to: String,
) -> Result<(), String> {
    let root = skills_root()?;
    Library { lock: &lock, gate: &gate, root: &root }.rename(writer.as_ref(), &scope, ws_id.as_deref(), &from, &to)
}

/// Rebuild and return the staging for one workspace — no view when the
/// library holds nothing for it (callers then inject no skills at all) — and
/// what it could not hand out whole. `excluded` are the rows the host judged
/// to have no usable description: they stage nowhere, and never shadow a fit
/// same-name row. An error is a stage that failed, never "no skills".
#[tauri::command(async)]
pub fn skills_stage(
    locks: tauri::State<'_, SkillsLocks>,
    gates: tauri::State<'_, GateRegistry>,
    forgotten: tauri::State<'_, Gate>,
    ws_id: String,
    excluded: Vec<staging::ExcludedSource>,
) -> Result<StagingAnswer, String> {
    let root = skills_root()?;
    library::require_safe(&ws_id, "workspace id")?;
    // The composition root owns the feature dependency; this command sees a
    // fresh bool from the registry and staging below stays artifacts-free.
    let claimed = gates.resolve(GateKey::Artifacts);
    staging::stage(&locks, &forgotten, &root, &ws_id, BUNDLED, claimed, &excluded)
        .map_err(|e| e.to_string())
}

/// Drop the stagings of workspaces that no longer exist. The library is user
/// content and is never touched here.
#[tauri::command(async)]
pub fn skills_prune(locks: tauri::State<'_, SkillsLocks>, live_ws_ids: Vec<String>) -> Result<(), String> {
    staging::prune_views(&locks, &skills_root()?, &live_ws_ids).map_err(|e| e.to_string())
}

/// Run `read` while the staged view holding `path` (a real path) stays whole
/// and in place: no stage swaps it and no prune removes it meanwhile. `None`
/// when `path` is inside no staged view.
pub(crate) fn reading_staged_view<T>(locks: &SkillsLocks, path: &Path, read: impl FnOnce() -> T) -> Option<T> {
    let staging = std::fs::canonicalize(staging::staging_dir(&skills_root().ok()?)).ok()?;
    let ws_id = staging::view_workspace(&staging, path)?;
    Some(locks.holding(&ws_id, read))
}

fn skills_root() -> Result<PathBuf, String> {
    let home = crate::paths::keepdeck_home().ok_or("no home directory for skills")?;
    Ok(root_in(&home))
}

/// KeepDeck's skills root under its `home`.
pub(crate) fn root_in(home: &Path) -> PathBuf {
    home.join("skills")
}

/// Where `ws_id`'s staging lives under `home`: its view and nothing else of
/// another workspace's.
pub(crate) fn staging_in(home: &Path, ws_id: &str) -> PathBuf {
    staging::staging_dir(&root_in(home)).join(ws_id)
}

/// Whether `path` is exactly a workspace's staged view under `home` — the
/// folder a CLI is pointed at, not a place inside it.
pub(crate) fn is_view_in(home: &Path, path: &Path) -> bool {
    let staging = staging::staging_dir(&root_in(home));
    staging::view_workspace(&staging, path).is_some_and(|ws| staging::view_of(&staging.join(&ws)) == path)
}

#[cfg(test)]
pub(crate) mod test_support {
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
}

#[cfg(test)]
mod tests {
    use super::test_support::root;
    use super::*;

    #[test]
    fn a_forgotten_writer_or_scope_writes_nothing_into_the_skills_library() {
        let (_tmp, root) = root();
        let lock = SkillsLibraryLock::default();
        let forget = crate::forgotten::testing::Forget::default();
        let gate = forget.gate();
        let lib = Library { lock: &lock, gate: &gate, root: &root };
        forget.forget("ws-gone");
        forget.forget("pane-7");
        let closed = Source { workspace: "ws-1".into(), team: None, pane: Some("pane-7".into()) };
        let into = |writer: Option<&Source>, ws_id: &str| lib.save(writer, "workspace", Some(ws_id), "review", "---\nname: review\n---\n", true);
        assert!(into(None, "ws-gone").unwrap_err().contains("closed"));
        assert!(into(Some(&closed), "ws-1").is_err());
        assert!(!root.join("library/ws").exists(), "nothing written");
        into(None, "ws-1").expect("the person writes into a live workspace");
        assert!(root.join("library/ws/ws-1/review/SKILL.md").is_file());
    }

    #[test]
    fn prune_on_a_fresh_home_is_a_no_op() {
        let (_tmp, root) = root();
        staging::prune_views(&SkillsLocks::default(), &root, &["ws-1".into()]).unwrap();
    }

    // ---- the refusal rule's three arms (design §4) + the bundled
    // staging half ----
    //
    // The arm tests call the real COMMANDS, which resolve skills_root()
    // through keepdeck_home() — a fresh tmp home per test by construction
    // (paths.rs), so no harness here: no env, no lock, no restore guard.
    // The day-one-shadow hazard the old isolation guarded against (a real
    // home carrying a user-authored artifacts skill turning arm 3's
    // create into a collision) is unreachable: this home is empty.

    #[test]
    fn tier_entries_materialize_identically() {
        // The F-R1 pin: a bundled skill stages exactly like a library skill —
        // on disk and as text, byte for byte the constant.
        let (_tmp, root) = root();
        let tier = [crate::skills::bundled::BundledSkill {
            name: "probe",
            content: "---\nname: probe\ndescription: \"Probe: the tier\"\n---\nBody\n",
            gate: None,
        }];
        let gate = crate::forgotten::testing::Forget::default().gate();
        let views = staging::stage(&SkillsLocks::default(), &gate, &root, "ws-1", &tier, false, &[])
            .unwrap()
            .view
            .unwrap();
        let staged = std::fs::read(PathBuf::from(&views.dir).join("probe").join(library::SKILL_FILE)).unwrap();
        assert_eq!(staged, tier[0].content.as_bytes(), "staged bytes == constant bytes");
        assert_eq!(views.skills[0].content, tier[0].content);
    }

    /// The library over `root`, nothing forgotten.
    fn with_library(root: &Path, test: impl FnOnce(&Library)) {
        let lock = SkillsLibraryLock::default();
        let gate = crate::forgotten::testing::Forget::default().gate();
        test(&Library { lock: &lock, gate: &gate, root });
    }

    #[test]
    fn the_three_refusal_arms_rust_side() {
        let (_tmp, root) = root();
        let global_dir = root.join("library").join("global");
        std::fs::create_dir_all(&global_dir).unwrap();
        with_library(&root, |lib| {
            // Arm 3: CREATE with a bundled name SUCCEEDS — the blessed shadow.
            lib.save(None, "global", None, "artifacts", "user's own copy", true).unwrap();
            assert!(global_dir.join("artifacts").join(library::SKILL_FILE).exists());

            // Arm 1: UPDATE on the existing (user) row → normal CRUD.
            lib.save(None, "global", None, "artifacts", "edited", false).unwrap();

            // Arm 2: DELETE (the row exists) → normal CRUD; then a second
            // delete (row ABSENT, bundled name) → the teaching refusal.
            lib.delete(None, "global", None, "artifacts").unwrap();
            let refusal = lib.delete(None, "global", None, "artifacts").unwrap_err();
            assert!(
                refusal.contains("bundled skill ships with the name"),
                "the teaching refusal names the shadow path: {refusal}"
            );

            // The upsert hole stays closed: an UPDATE on an absent bundled
            // name refuses rather than silently creating a row.
            let upsert = lib.save(None, "global", None, "artifacts", "sneaky shadow", false).unwrap_err();
            assert!(upsert.contains("bundled skill ships with the name"));
            assert!(
                !global_dir.join("artifacts").join(library::SKILL_FILE).exists(),
                "no row was silently created"
            );
        });
    }

    #[test]
    fn the_rename_matrix_for_bundled_names() {
        let (_tmp, root) = root();
        let global_dir = root.join("library").join("global");
        std::fs::create_dir_all(&global_dir).unwrap();
        library::save(&global_dir, "mine", "content").unwrap();
        with_library(&root, |lib| {
            // Rename ONTO a bundled name (absent target): an authoring act —
            // SUCCEEDS (any-free-name semantics, visible in the list).
            lib.rename(None, "global", None, "mine", "artifacts").unwrap();
            assert!(global_dir.join("artifacts").join(library::SKILL_FILE).exists());
            assert!(!global_dir.join("mine").exists());

            // Rename FROM an absent bundled name → arm 2 teaching refusal.
            library::delete(&global_dir, "artifacts").unwrap();
            library::save(&global_dir, "other", "content").unwrap();
            let refusal = lib.rename(None, "global", None, "artifacts", "other").unwrap_err();
            assert!(refusal.contains("bundled skill ships with the name"));
        });
    }

    #[test]
    fn a_bundled_scope_argument_refuses_with_the_teaching_text() {
        let (_tmp, root) = root();
        with_library(&root, |lib| {
            let refusal = lib.save(None, "bundled", None, "anything", "content", true).unwrap_err();
            assert!(
                refusal.contains("bundled skills ship with KeepDeck"),
                "the scope argument refuses with the copy-into-your-own teaching: {refusal}"
            );
            let del = lib.delete(None, "bundled", None, "anything").unwrap_err();
            assert!(del.contains("bundled skills ship with KeepDeck"));
            let ren = lib.rename(None, "bundled", None, "a", "b").unwrap_err();
            assert!(ren.contains("bundled skills ship with KeepDeck"));
        });
    }
}
