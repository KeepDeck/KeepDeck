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

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
    root: ClaimedRoot,
    /// Serializes every read and write of board files.
    data: Mutex<()>,
}

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
        *enabled = Some(Enabled {
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
