//! Tasks: the team-owned board of work orders, every board in ONE
//! database (keepdeck-tasks). The store owns the disk; the TS domain owns
//! every rule about what a board holds; the TS owner keeps the live board
//! and hands the store the change from what the database confirmed.
//! No display server and no delivery: a task never reaches an agent on
//! its own — the board is a record (the user's decision, 2026-09-19).

mod store;

use tauri::State;

pub use store::TasksStore;

use keepdeck_tasks::{Applied, ChangeSet, LegacyBoard, MigrationSource, SearchHit, StoreError, StoreStatus, StoredBoard};

pub struct TasksState {
    store: TasksStore,
}

impl TasksState {
    pub fn new() -> Self {
        Self {
            store: TasksStore::default(),
        }
    }
}

impl Default for TasksState {
    fn default() -> Self {
        Self::new()
    }
}

/// The store root: `<keepdeck home>/tasks` — the app's OWN home, like the
/// artifacts store and for the same reason: Tauri's data dir is shared by
/// a debug and an installed build while the claim is exclusive.
fn store_root() -> Result<std::path::PathBuf, String> {
    crate::paths::keepdeck_home()
        .map(|home| home.join("tasks"))
        .ok_or_else(|| "no KeepDeck home to hold the task board".to_string())
}

#[tauri::command(async)]
pub fn tasks_enable(state: State<TasksState>) -> Result<(), String> {
    let root = store_root()?;
    state.store.enable(&root)?;
    log::info!("tasks: board store claimed at {}", root.display());
    Ok(())
}

#[tauri::command(async)]
pub fn tasks_disable(state: State<TasksState>) {
    state.store.disable();
    log::info!("tasks: board store released");
}

/// Drop a closing workspace's board — its rows in the database and its
/// files (the board's old JSON and every copy of it). Idempotent.
#[tauri::command(async)]
pub fn tasks_drop_workspace(state: State<TasksState>, ws_id: String) -> Result<(), String> {
    state.store.with_db(|db| db.drop_workspace(&ws_id)).map_err(|e| e.to_string())?;
    state.store.drop_workspace(&ws_id)
}

// ── The database (keepdeck-tasks): every board in one store ──────────────
// Errors are CODES (`StoreError`), never sentences: the TS owner decides
// from them whether a write is tried again and whether the store is in doubt.

#[tauri::command(async)]
pub fn tasks_status(state: State<TasksState>) -> Result<StoreStatus, StoreError> {
    state.store.with_db(|db| db.status())
}

/// A workspace's board, or null when it has none yet.
#[tauri::command(async)]
pub fn tasks_load(state: State<TasksState>, workspace: String) -> Result<Option<StoredBoard>, StoreError> {
    state.store.with_db(|db| db.load_workspace(&workspace))
}

/// Every board, attached or not — what a migration is read back as.
#[tauri::command(async)]
pub fn tasks_load_all(state: State<TasksState>) -> Result<Vec<StoredBoard>, StoreError> {
    state.store.with_db(|db| db.load_all())
}

#[tauri::command(async)]
pub fn tasks_apply(state: State<TasksState>, change: ChangeSet) -> Result<Applied, StoreError> {
    state.store.with_db(|db| db.apply(&change))
}

#[tauri::command(async)]
pub fn tasks_search(
    state: State<TasksState>,
    query: String,
    boards: Vec<String>,
    limit: i64,
) -> Result<Vec<SearchHit>, StoreError> {
    state.store.with_db(|db| db.search(&query, &boards, limit))
}

// ── The migration from the JSON files: every board at once ───────────────

/// Every board file on disk, read at once.
#[tauri::command(async)]
pub fn tasks_legacy_boards(state: State<TasksState>) -> Result<Vec<LegacyBoard>, String> {
    state.store.legacy_boards()
}

#[tauri::command(async)]
pub fn tasks_import(
    state: State<TasksState>,
    boards: Vec<StoredBoard>,
    sources: Vec<MigrationSource>,
) -> Result<(), StoreError> {
    state.store.with_db(|db| db.import(&boards, &sources))
}

#[tauri::command(async)]
pub fn tasks_migration_sources(state: State<TasksState>) -> Result<Vec<MigrationSource>, StoreError> {
    state.store.with_db(|db| db.migration_sources())
}

/// The import read back equal: the database becomes the source, and the
/// files become `board.pre-db.json` copies.
#[tauri::command(async)]
pub fn tasks_activate_migration(state: State<TasksState>) -> Result<(), StoreError> {
    state.store.with_db(|db| db.activate_migration())?;
    state.store.retire_legacy().map_err(|detail| StoreError::Io { detail })
}

#[tauri::command(async)]
pub fn tasks_discard_migration(state: State<TasksState>) -> Result<(), StoreError> {
    state.store.with_db(|db| db.discard_migration())
}

// ── Restoring a damaged database: only ever the person's act ─────────────

#[tauri::command(async)]
pub fn tasks_restore_backup(state: State<TasksState>, at: i64) -> Result<(), StoreError> {
    state.store.with_db(|db| db.restore_backup(at, now_ms()))
}

#[tauri::command(async)]
pub fn tasks_restore_boards(state: State<TasksState>, boards: Vec<StoredBoard>) -> Result<(), StoreError> {
    state.store.with_db(|db| db.restore_boards(&boards, now_ms()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
