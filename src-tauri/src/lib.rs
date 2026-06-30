mod dnd;
mod links;
mod session;
mod worktree;

use serde::Serialize;

/// Build/runtime info surfaced to the deck UI.
///
/// Doubles as the IPC smoke test for the skeleton: if the UI can render this,
/// the React <-> Rust bridge is wired. Real fleet/observability commands land
/// on top of this same handler.
#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

impl AppInfo {
    fn current() -> Self {
        Self {
            name: "KeepDeck".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo::current()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(session::SessionRegistry::default())
        .manage(worktree::RepoLocks::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            dnd::paths_are_images,
            links::open_url,
            links::open_path,
            session::session_spawn,
            session::session_write,
            session::session_resize,
            session::session_close,
            worktree::worktree_inspect,
            worktree::worktree_suggest,
            worktree::worktree_create,
            worktree::worktree_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_crate_identity() {
        let info = AppInfo::current();
        assert_eq!(info.name, "KeepDeck");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert!(!info.version.is_empty(), "version must not be empty");
    }
}
