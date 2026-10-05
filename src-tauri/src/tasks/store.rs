//! The task board store: one `board.json` per workspace under the claimed
//! root (`<keepdeck home>/tasks/ws/<workspaceId>/board.json`).
//!
//! The FORMAT — what a board is, what a task may hold, every cap on a
//! field — is the TS domain's (`src/domain/tasks`), and it is enforced
//! there and nowhere else: this store keeps the bytes the domain accepted,
//! writes them atomically, and hands them back verbatim. A second copy of
//! the field rules here would be the two-language drift the design rules
//! forbid. What the store does own are the two guards only the disk can
//! ask for: a workspace id is a PATH SEGMENT (the one shared `fs_names`
//! wall), and a write is bounded in size against a runaway payload.
//!
//! Concurrency: one process owns the root (`fs_claim`, taken at enable),
//! and inside it every read and write of one workspace's file serializes
//! on the data mutex — the same shape as the artifacts store. The TS owner
//! keeps the live board in memory and writes whole boards, so the store
//! never has to merge.
//!
//! The boards are moving into ONE database under the same root
//! (`keepdeck-tasks`, task-221): opened at enable beside the files, it is
//! the boards' source once the migration is active. The files are then
//! read only by the migration and kept as `board.pre-db.json` copies.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use keepdeck_tasks::{LegacyBoard, Store, StoreError};
use sha2::{Digest, Sha256};

use crate::fs_claim::{claim, ClaimedRoot};
use crate::state::write_atomic;

/// A bound on one board file — not a rule about content (the domain
/// caps tasks, bodies and comments far below this) but a wall against a
/// payload no honest board could produce.
pub(crate) const BOARD_FILE_CAP_BYTES: usize = 64 * 1024 * 1024;

const BOARD_FILE: &str = "board.json";

/// The refusal every operation gives while the store is off. Mirrors the
/// artifacts store's sentence: the word names the switch to flip.
pub const OFF_MESSAGE: &str = "task board is off — turn Tasks on first";

pub struct TasksStore {
    enabled: Mutex<Option<Enabled>>,
}

struct Enabled {
    /// The database, shared with the backup ticker (which holds it weakly,
    /// so it ends with the claim). Declared before the claim: fields drop
    /// in order, and the database closes — log folded in — before the
    /// claim is let go.
    db: Arc<Mutex<Store>>,
    root: ClaimedRoot,
    /// Serializes every read and write of board files.
    data: Mutex<()>,
}

/// How often the backup ticker asks whether a backup is due; the rule of
/// WHEN one is due is the store's (`Store::backup_if_due`).
const BACKUP_TICK: std::time::Duration = std::time::Duration::from_secs(5 * 60);

pub const PRE_DB_COPY: &str = "pre-db";

impl Default for TasksStore {
    fn default() -> Self {
        Self {
            enabled: Mutex::new(None),
        }
    }
}

impl TasksStore {
    /// Claim the root (idempotent — enabling while enabled IS the state
    /// asked for). Contention surfaces verbatim so the toggle can say WHY.
    pub fn enable(&self, root: &Path) -> Result<(), String> {
        let mut enabled = self.enabled.lock().expect("tasks store poisoned");
        if enabled.is_some() {
            return Ok(());
        }
        let claimed = claim(root, "task board")?;
        // Damage or a newer schema is no failure to enable: the store opens
        // in the state that says so, and the UI offers the way out.
        let db = Store::open(root).map_err(|e| e.to_string())?;
        let db = Arc::new(Mutex::new(db));
        spawn_backup_ticker(Arc::downgrade(&db));
        *enabled = Some(Enabled {
            db,
            root: claimed,
            data: Mutex::new(()),
        });
        Ok(())
    }

    /// Release the claim. Off while off is a no-op.
    pub fn disable(&self) {
        let mut enabled = self.enabled.lock().expect("tasks store poisoned");
        *enabled = None;
    }

    fn with_enabled<T>(
        &self,
        run: impl FnOnce(&Path, &Mutex<()>) -> Result<T, String>,
    ) -> Result<T, String> {
        let enabled = self.enabled.lock().expect("tasks store poisoned");
        let Some(state) = enabled.as_ref() else {
            return Err(OFF_MESSAGE.to_string());
        };
        run(state.root.root(), &state.data)
    }

    /// Run `op` on the open database.
    pub fn with_db<T>(
        &self,
        op: impl FnOnce(&mut Store) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let db = {
            let enabled = self.enabled.lock().expect("tasks store poisoned");
            match enabled.as_ref() {
                Some(state) => state.db.clone(),
                None => return Err(StoreError::Off),
            }
        };
        let mut db = db.lock().expect("tasks db poisoned");
        op(&mut db)
    }

    /// Every board file under the root, read at once for the migration —
    /// all of them or the reason none could be read.
    pub fn legacy_boards(&self) -> Result<Vec<LegacyBoard>, String> {
        self.with_enabled(|root, data| {
            let _guard = data.lock().expect("tasks data poisoned");
            let ws_dir = root.join("ws");
            let entries = match fs::read_dir(&ws_dir) {
                Ok(entries) => entries,
                Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
                Err(e) => return Err(format!("reading {} failed: {e}", ws_dir.display())),
            };
            let mut boards = Vec::new();
            for entry in entries {
                let entry = entry.map_err(|e| format!("reading {} failed: {e}", ws_dir.display()))?;
                let Some(workspace) = entry.file_name().to_str().map(str::to_string) else { continue };
                if !crate::fs_names::is_safe_segment(&workspace) {
                    continue;
                }
                let path = board_path(root, &workspace);
                match fs::read_to_string(&path) {
                    Ok(json) => boards.push(LegacyBoard { checksum: checksum(&json), workspace, json }),
                    Err(e) if e.kind() == ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("reading {} failed: {e}", path.display())),
                }
            }
            boards.sort_by(|a, b| a.workspace.cmp(&b.workspace));
            Ok(boards)
        })
    }

    /// After the migration is active: every `board.json` becomes its
    /// `board.pre-db.json` copy — the files stop being a source. A copy
    /// already there is the first one, and stays.
    pub fn retire_legacy(&self) -> Result<(), String> {
        let boards = self.legacy_boards()?;
        for board in boards {
            self.keep_copy(&board.workspace, PRE_DB_COPY)?;
            self.with_enabled(|root, data| {
                let _guard = data.lock().expect("tasks data poisoned");
                fs::remove_file(board_path(root, &board.workspace))
                    .map_err(|e| format!("retiring the board file of {} failed: {e}", board.workspace))
            })?;
        }
        Ok(())
    }

    /// One workspace's board as stored, or `None` when it has never been
    /// written — absence is a fact, not a failure.
    pub fn read(&self, workspace_id: &str) -> Result<Option<String>, String> {
        self.with_enabled(|root, data| {
            require_safe(workspace_id)?;
            let _guard = data.lock().expect("tasks data poisoned");
            match fs::read_to_string(board_path(root, workspace_id)) {
                Ok(json) => Ok(Some(json)),
                Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
                Err(e) => Err(format!("reading the task board for {workspace_id} failed: {e}")),
            }
        })
    }

    /// Replace one workspace's board, atomically.
    pub fn write(&self, workspace_id: &str, json: &str) -> Result<(), String> {
        if json.len() > BOARD_FILE_CAP_BYTES {
            return Err(format!(
                "task board for {workspace_id} exceeds {BOARD_FILE_CAP_BYTES} bytes"
            ));
        }
        self.with_enabled(|root, data| {
            require_safe(workspace_id)?;
            let _guard = data.lock().expect("tasks data poisoned");
            write_atomic(&board_path(root, workspace_id), json.as_bytes())
                .map_err(|e| format!("writing the task board for {workspace_id} failed: {e}"))
        })
    }

    /// Keep the board as it is now beside it, as `board.<label>.json` —
    /// once: a copy already there is the first one, and stays. What a
    /// change of the board's FORMAT takes before its first write, so an
    /// older build (or a person) has the old file to go back to. Nothing
    /// to keep — no board yet — is no failure.
    pub fn keep_copy(&self, workspace_id: &str, label: &str) -> Result<(), String> {
        if !is_label(label) {
            return Err(format!("unsafe board copy label: {label:?}"));
        }
        self.with_enabled(|root, data| {
            require_safe(workspace_id)?;
            let _guard = data.lock().expect("tasks data poisoned");
            let copy = root.join("ws").join(workspace_id).join(format!("board.{label}.json"));
            if copy.exists() {
                return Ok(());
            }
            match fs::read(board_path(root, workspace_id)) {
                Ok(bytes) => write_atomic(&copy, &bytes)
                    .map_err(|e| format!("keeping a copy of the task board for {workspace_id} failed: {e}")),
                Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("reading the task board for {workspace_id} failed: {e}")),
            }
        })
    }

    /// Drop a workspace's board — called from workspace deletion, the one
    /// place that knows the live workspace set. Idempotent on absence.
    pub fn drop_workspace(&self, workspace_id: &str) -> Result<(), String> {
        self.with_enabled(|root, data| {
            require_safe(workspace_id)?;
            let _guard = data.lock().expect("tasks data poisoned");
            match fs::remove_dir_all(root.join("ws").join(workspace_id)) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("dropping the task board for {workspace_id} failed: {e}")),
            }
        })
    }
}

/// A copy's label becomes part of a file name: lowercase words and dashes.
fn is_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 40
        && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The checksum the migration keeps for each source file.
fn checksum(json: &str) -> String {
    Sha256::digest(json.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Ask the store for a backup every tick while it is enabled; the ticker
/// ends when the database it watches is gone (disable, or exit).
fn spawn_backup_ticker(db: Weak<Mutex<Store>>) {
    let spawned = std::thread::Builder::new().name("tasks-backup".into()).spawn(move || loop {
        let Some(db) = db.upgrade() else { return };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        match db.lock().expect("tasks db poisoned").backup_if_due(now) {
            Ok(Some(taken)) => log::info!("tasks: backup taken at {}", taken.path.display()),
            Ok(None) => {}
            Err(error) => log::warn!("tasks: backup failed: {error}"),
        }
        drop(db);
        std::thread::sleep(BACKUP_TICK);
    });
    if let Err(error) = spawned {
        log::warn!("tasks: no backup ticker: {error}");
    }
}

fn board_path(root: &Path, workspace_id: &str) -> PathBuf {
    root.join("ws").join(workspace_id).join(BOARD_FILE)
}

/// The workspace id arrives as a raw invoke argument and becomes a path
/// segment: judged by the ONE shared wall, or `../../x` would read and
/// delete outside the store.
fn require_safe(workspace_id: &str) -> Result<(), String> {
    if crate::fs_names::is_safe_segment(workspace_id) {
        Ok(())
    } else {
        Err(format!("unsafe workspace id: {workspace_id:?}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled_store() -> (tempfile::TempDir, TasksStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = TasksStore::default();
        store.enable(&dir.path().join("tasks")).expect("enable");
        (dir, store)
    }

    #[test]
    fn every_operation_refuses_while_off_with_the_switch_named() {
        let store = TasksStore::default();
        assert_eq!(store.read("ws-1").unwrap_err(), OFF_MESSAGE);
        assert_eq!(store.write("ws-1", "{}").unwrap_err(), OFF_MESSAGE);
        assert_eq!(store.drop_workspace("ws-1").unwrap_err(), OFF_MESSAGE);
        assert_eq!(store.keep_copy("ws-1", "pre-relations").unwrap_err(), OFF_MESSAGE);
    }

    #[test]
    fn enable_is_idempotent_and_a_never_written_board_reads_as_absent() {
        let (dir, store) = enabled_store();
        store.enable(&dir.path().join("tasks")).expect("second enable");
        assert_eq!(store.read("ws-1").unwrap(), None);
    }

    #[test]
    fn a_written_board_reads_back_verbatim_from_its_workspace_file() {
        let (dir, store) = enabled_store();
        let json = r#"{"nextId":3,"tasks":[{"id":"task-1"}]}"#;
        store.write("ws-1", json).expect("write");
        assert_eq!(store.read("ws-1").unwrap().as_deref(), Some(json));
        assert!(dir.path().join("tasks/ws/ws-1/board.json").is_file());
        // Another workspace's board is another file.
        assert_eq!(store.read("ws-2").unwrap(), None);
    }

    #[test]
    fn a_kept_copy_is_the_board_as_it_was_and_only_the_first_one_stays() {
        let (dir, store) = enabled_store();
        // Nothing written yet: nothing to keep, and no failure.
        store.keep_copy("ws-1", "pre-relations").expect("nothing to keep");
        assert!(!dir.path().join("tasks/ws/ws-1/board.pre-relations.json").exists());
        store.write("ws-1", "old").unwrap();
        store.keep_copy("ws-1", "pre-relations").expect("keep");
        store.write("ws-1", "new").unwrap();
        store.keep_copy("ws-1", "pre-relations").expect("keep again");
        let kept = std::fs::read_to_string(dir.path().join("tasks/ws/ws-1/board.pre-relations.json")).unwrap();
        assert_eq!(kept, "old");
        assert_eq!(store.read("ws-1").unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn a_copy_label_that_is_no_plain_word_is_refused() {
        let (_dir, store) = enabled_store();
        for label in ["", "../x", "Pre", "a/b", "a.b"] {
            assert!(store.keep_copy("ws-1", label).is_err(), "{label}");
        }
        // And the workspace id is judged by the same wall as every read.
        assert!(store.keep_copy("../ws", "pre-relations").is_err());
    }

    #[test]
    fn a_write_replaces_the_previous_board_whole() {
        let (_dir, store) = enabled_store();
        store.write("ws-1", "1").unwrap();
        store.write("ws-1", "2").unwrap();
        assert_eq!(store.read("ws-1").unwrap().as_deref(), Some("2"));
    }

    #[test]
    fn a_payload_over_the_file_cap_is_refused_before_touching_the_disk() {
        let (dir, store) = enabled_store();
        let huge = "x".repeat(BOARD_FILE_CAP_BYTES + 1);
        let refused = store.write("ws-1", &huge).unwrap_err();
        assert!(refused.contains("exceeds"), "{refused}");
        assert!(!dir.path().join("tasks/ws/ws-1").exists());
    }

    #[test]
    fn an_unsafe_workspace_id_is_refused_on_every_door() {
        let (_dir, store) = enabled_store();
        for bad in ["../x", "a/b", "", "."] {
            assert!(store.read(bad).unwrap_err().contains("unsafe workspace id"), "read {bad:?}");
            assert!(store.write(bad, "{}").unwrap_err().contains("unsafe workspace id"), "write {bad:?}");
            assert!(store.drop_workspace(bad).unwrap_err().contains("unsafe workspace id"), "drop {bad:?}");
        }
    }

    #[test]
    fn dropping_a_workspace_removes_its_board_and_is_idempotent() {
        let (dir, store) = enabled_store();
        store.write("ws-1", "{}").unwrap();
        store.drop_workspace("ws-1").expect("drop");
        assert!(!dir.path().join("tasks/ws/ws-1").exists());
        assert_eq!(store.read("ws-1").unwrap(), None);
        store.drop_workspace("ws-1").expect("drop again");
    }

    #[test]
    fn enabling_opens_the_database_beside_the_files_and_off_refuses_it() {
        let off = TasksStore::default();
        assert_eq!(off.with_db(|db| db.status()).unwrap_err(), StoreError::Off);
        let (dir, store) = enabled_store();
        assert!(matches!(store.with_db(|db| db.status()).unwrap(), keepdeck_tasks::StoreStatus::Ready { .. }));
        assert!(dir.path().join("tasks/tasks.db").is_file());
    }

    #[test]
    fn the_migration_reads_every_board_file_at_once_with_its_checksum() {
        let (_dir, store) = enabled_store();
        assert_eq!(store.legacy_boards().unwrap(), vec![]);
        store.write("ws-2", "two").unwrap();
        store.write("ws-1", "one").unwrap();
        store.keep_copy("ws-1", "pre-relations").unwrap();
        let boards = store.legacy_boards().unwrap();
        assert_eq!(boards.iter().map(|b| (b.workspace.as_str(), b.json.as_str())).collect::<Vec<_>>(), vec![("ws-1", "one"), ("ws-2", "two")]);
        // A checksum of the bytes: equal bytes, equal sums; other bytes, other sums.
        assert_eq!(boards[0].checksum, checksum("one"));
        assert_ne!(boards[0].checksum, boards[1].checksum);
        assert_eq!(boards[0].checksum.len(), 64);
    }

    #[test]
    fn retiring_the_files_keeps_each_board_as_its_pre_db_copy_only() {
        let (dir, store) = enabled_store();
        store.write("ws-1", "one").unwrap();
        store.retire_legacy().unwrap();
        assert!(!dir.path().join("tasks/ws/ws-1/board.json").exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("tasks/ws/ws-1/board.pre-db.json")).unwrap(), "one");
        // Nothing left to read as a source.
        assert_eq!(store.legacy_boards().unwrap(), vec![]);
    }

    #[test]
    fn disabling_releases_the_claim_for_the_next_owner() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tasks");
        let first = TasksStore::default();
        first.enable(&root).unwrap();
        let second = TasksStore::default();
        assert_eq!(
            second.enable(&root).unwrap_err(),
            "task board is owned by another KeepDeck process"
        );
        first.disable();
        second.enable(&root).expect("claim after release");
    }
}
