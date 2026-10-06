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
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use keepdeck_tasks::{LegacyBoard, Store, StoreError};
use sha2::{Digest, Sha256};

use crate::fs_claim::{claim, ClaimedRoot};
use crate::state::write_atomic;

const BOARD_FILE: &str = "board.json";

/// The refusal every operation gives while the store is off. Mirrors the
/// artifacts store's sentence: the word names the switch to flip.
pub const OFF_MESSAGE: &str = "task board is off — turn Tasks on first";

pub struct TasksStore {
    enabled: Mutex<Option<Enabled>>,
}

struct Enabled {
    /// Shared with every operation in flight and the backup ticker.
    db: Arc<Database>,
    /// Serializes every read and write of board files.
    data: Mutex<()>,
}

/// The database and the claim on its root, held together: whoever still
/// holds one holds both, so the claim is let go only once the database is
/// closed — never while an operation or a backup still has it open.
struct Database {
    /// Declared before the claim: fields drop in order, and the store
    /// closes — log folded in — before the claim goes.
    store: Mutex<Store>,
    claim: ClaimedRoot,
}

/// How often the backup ticker asks whether a backup is due; the rule of
/// WHEN one is due is the store's (`Store::backup_due`).
const BACKUP_TICK: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// How long after enable the first tick waits.
const FIRST_BACKUP_AFTER: std::time::Duration = std::time::Duration::from_secs(60);

/// The copy each board file becomes once the boards live in the database.
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
        let mut enabled = lock(&self.enabled);
        if enabled.is_some() {
            return Ok(());
        }
        let claimed = claim(root, "task board")?;
        // Damage or a newer schema is no failure to enable: the store opens
        // in the state that says so, and the UI offers the way out.
        let store = Store::open(root).map_err(|e| e.to_string())?;
        let db = Arc::new(Database { store: Mutex::new(store), claim: claimed });
        spawn_backup_ticker(Arc::downgrade(&db));
        *enabled = Some(Enabled {
            db,
            data: Mutex::new(()),
        });
        Ok(())
    }

    /// Close the database and release the claim. An operation still in
    /// flight finishes first; one that holds the database after finds it
    /// closed, and the claim goes with the last holder. Off while off is a
    /// no-op.
    pub fn disable(&self) {
        let Some(enabled) = lock(&self.enabled).take() else { return };
        lock(&enabled.db.store).close();
    }

    fn with_enabled<T>(
        &self,
        run: impl FnOnce(&Path, &Mutex<()>) -> Result<T, String>,
    ) -> Result<T, String> {
        let enabled = lock(&self.enabled);
        let Some(state) = enabled.as_ref() else {
            return Err(OFF_MESSAGE.to_string());
        };
        run(state.db.claim.root(), &state.data)
    }

    /// Run `op` on the open database.
    pub fn with_db<T>(
        &self,
        op: impl FnOnce(&mut Store) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let db = match lock(&self.enabled).as_ref() {
            Some(state) => state.db.clone(),
            None => return Err(StoreError::Off),
        };
        let mut store = lock(&db.store);
        op(&mut store)
    }

    /// Every board file under the root, read at once for the migration —
    /// all of them or the reason none could be read.
    pub fn legacy_boards(&self) -> Result<Vec<LegacyBoard>, String> {
        self.with_enabled(|root, data| {
            let _guard = lock(data);
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
    /// already there (a retire cut short after it) is the first one, and
    /// stays. Nothing left: nothing to do.
    pub fn retire_legacy(&self) -> Result<(), String> {
        let boards = self.legacy_boards()?;
        for board in boards {
            self.with_enabled(|root, data| {
                let _guard = lock(data);
                let file = board_path(root, &board.workspace);
                let copy = file.with_file_name(format!("board.{PRE_DB_COPY}.json"));
                // The first copy kept is the one that stays.
                if !copy.exists() {
                    write_atomic(&copy, board.json.as_bytes())
                        .map_err(|e| format!("keeping the copy of {}'s board failed: {e}", board.workspace))?;
                }
                fs::remove_file(&file).map_err(|e| format!("retiring the board file of {} failed: {e}", board.workspace))
            })?;
        }
        Ok(())
    }

    /// Drop a workspace's board — called from workspace deletion, the one
    /// place that knows the live workspace set. Idempotent on absence.
    pub fn drop_workspace(&self, workspace_id: &str) -> Result<(), String> {
        self.with_enabled(|root, data| {
            require_safe(workspace_id)?;
            let _guard = lock(data);
            match fs::remove_dir_all(root.join("ws").join(workspace_id)) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("dropping the task board for {workspace_id} failed: {e}")),
            }
        })
    }
}

/// The checksum the migration keeps for each source file.
fn checksum(json: &str) -> String {
    Sha256::digest(json.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Ask the store for a backup every tick while it is enabled; the ticker
/// ends when the database it watches is gone (disable, or exit).
fn spawn_backup_ticker(db: Weak<Database>) {
    let spawned = std::thread::Builder::new().name("tasks-backup".into()).spawn(move || {
        // Not at the very moment of enable: the first commands are the UI's.
        std::thread::sleep(FIRST_BACKUP_AFTER);
        loop {
            let Some(db) = db.upgrade() else { return };
            backup_once(&db);
            drop(db);
            std::thread::sleep(BACKUP_TICK);
        }
    });
    if let Err(error) = spawned {
        log::warn!("tasks: no backup ticker: {error}");
    }
}

/// One tick: decided under the store's lock, copied without it — no
/// command waits on a backup being taken.
fn backup_once(db: &Database) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let job = match lock(&db.store).backup_due(now) {
        Ok(Some(job)) => job,
        Ok(None) => return,
        Err(error) => return log::warn!("tasks: backup not taken: {error}"),
    };
    match job.take() {
        Ok(taken) => {
            lock(&db.store).backup_taken(&job);
            log::info!("tasks: backup taken at {}", taken.path.display());
        }
        Err(error) => log::warn!("tasks: backup failed: {error}"),
    }
}

/// A lock that outlives a panic under it: one operation that panicked
/// must not turn every later task command into a panic too. What it was
/// doing is the store's transaction to have rolled back.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| {
        log::error!("tasks: a task operation panicked; carrying on");
        poisoned.into_inner()
    })
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

    /// A board file as an earlier build wrote it.
    fn put(dir: &tempfile::TempDir, workspace: &str, json: &str) {
        let path = dir.path().join("tasks/ws").join(workspace);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("board.json"), json).unwrap();
    }

    #[test]
    fn every_operation_refuses_while_off_with_the_switch_named() {
        let store = TasksStore::default();
        assert_eq!(store.legacy_boards().unwrap_err(), OFF_MESSAGE);
        assert_eq!(store.retire_legacy().unwrap_err(), OFF_MESSAGE);
        assert_eq!(store.drop_workspace("ws-1").unwrap_err(), OFF_MESSAGE);
        assert_eq!(store.with_db(|db| db.status()).unwrap_err(), StoreError::Off);
    }

    #[test]
    fn enabling_opens_the_database_beside_the_files_and_is_idempotent() {
        let (dir, store) = enabled_store();
        store.enable(&dir.path().join("tasks")).expect("second enable");
        assert!(matches!(store.with_db(|db| db.status()).unwrap(), keepdeck_tasks::StoreStatus::Ready { .. }));
        assert!(dir.path().join("tasks/tasks.db").is_file());
    }

    #[test]
    fn the_migration_reads_every_board_file_at_once_with_its_checksum() {
        let (dir, store) = enabled_store();
        assert_eq!(store.legacy_boards().unwrap(), vec![]);
        put(&dir, "ws-2", "two");
        put(&dir, "ws-1", "one");
        // A copy beside a board is no board.
        std::fs::write(dir.path().join("tasks/ws/ws-1/board.pre-relations.json"), "old").unwrap();
        let boards = store.legacy_boards().unwrap();
        assert_eq!(
            boards.iter().map(|b| (b.workspace.as_str(), b.json.as_str())).collect::<Vec<_>>(),
            vec![("ws-1", "one"), ("ws-2", "two")]
        );
        assert_eq!(boards[0].checksum, checksum("one"));
        assert_ne!(boards[0].checksum, boards[1].checksum);
        assert_eq!(boards[0].checksum.len(), 64);
    }

    #[test]
    fn retiring_the_files_keeps_each_board_as_its_first_pre_db_copy_only() {
        let (dir, store) = enabled_store();
        put(&dir, "ws-1", "one");
        store.retire_legacy().unwrap();
        assert!(!dir.path().join("tasks/ws/ws-1/board.json").exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("tasks/ws/ws-1/board.pre-db.json")).unwrap(), "one");
        assert_eq!(store.legacy_boards().unwrap(), vec![]);
        // Asked again with nothing left: nothing happens.
        store.retire_legacy().unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("tasks/ws/ws-1/board.pre-db.json")).unwrap(), "one");
    }

    #[test]
    fn an_unsafe_workspace_id_is_refused_and_never_read() {
        let (dir, store) = enabled_store();
        for bad in ["../x", "a/b", "", "."] {
            assert!(store.drop_workspace(bad).unwrap_err().contains("unsafe workspace id"), "drop {bad:?}");
        }
        std::fs::create_dir_all(dir.path().join("tasks/ws/.hidden")).unwrap();
        std::fs::write(dir.path().join("tasks/ws/.hidden/board.json"), "x").unwrap();
        assert!(store.legacy_boards().unwrap().iter().all(|b| b.workspace != ".hidden"));
    }

    #[test]
    fn dropping_a_workspace_removes_its_files_and_is_idempotent() {
        let (dir, store) = enabled_store();
        put(&dir, "ws-1", "{}");
        store.drop_workspace("ws-1").expect("drop");
        assert!(!dir.path().join("tasks/ws/ws-1").exists());
        store.drop_workspace("ws-1").expect("drop again");
    }

    #[test]
    fn disabling_closes_the_database_and_the_claim_goes_with_its_last_holder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tasks");
        let first = TasksStore::default();
        first.enable(&root).unwrap();
        // An operation — or the backup ticker — still holds the database.
        let held = lock(&first.enabled).as_ref().unwrap().db.clone();
        first.disable();
        assert_eq!(lock(&held.store).status().unwrap_err(), StoreError::Off);
        let second = TasksStore::default();
        assert!(second.enable(&root).is_err(), "the claim went while the database was still held");
        drop(held);
        second.enable(&root).expect("claim after the last holder let go");
    }

    #[test]
    fn a_panic_under_the_lock_leaves_the_store_usable() {
        let (_dir, store) = enabled_store();
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = store.with_db(|_| -> Result<(), StoreError> { panic!("mid-operation") });
        }));
        assert!(caught.is_err());
        assert!(store.with_db(|db| db.status()).is_ok());
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
