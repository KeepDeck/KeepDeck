//! Tasks: the team-owned board of work orders, persisted per workspace.
//! The store owns the disk; the TS domain owns every rule about what a
//! board holds; the TS owner keeps the live board and writes it whole.
//! No display server and no delivery: a task never reaches an agent on
//! its own — the board is a record (the user's decision, 2026-09-19).

mod store;

use tauri::State;

pub use store::TasksStore;

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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePayload {
    workspace_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritePayload {
    workspace_id: String,
    json: String,
}

/// One workspace's board as stored, or null when it was never written.
#[tauri::command(async)]
pub fn tasks_read(
    state: State<TasksState>,
    payload: WorkspacePayload,
) -> Result<Option<String>, String> {
    state.store.read(&payload.workspace_id)
}

#[tauri::command(async)]
pub fn tasks_write(state: State<TasksState>, payload: WritePayload) -> Result<(), String> {
    state.store.write(&payload.workspace_id, &payload.json)
}

/// Drop a closing workspace's board. Idempotent.
#[tauri::command(async)]
pub fn tasks_drop_workspace(state: State<TasksState>, ws_id: String) -> Result<(), String> {
    state.store.drop_workspace(&ws_id)
}
