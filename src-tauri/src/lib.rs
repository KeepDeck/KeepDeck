mod agents;
mod dnd;
mod history;
mod links;
mod menu;
mod session;
mod sessions;
mod state;
mod worktree;

use serde::Serialize;
use tauri::Manager as _;

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
        .plugin(tauri_plugin_clipboard_manager::init())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::handle_event(app, event.id().as_ref()))
        .manage(session::SessionRegistry::default())
        .manage(worktree::RepoLocks::default())
        .setup(|app| {
            // The session spool: agents report their session ids here; the
            // watcher lives as managed state for the app's lifetime.
            let watcher = sessions::watch_spool(app.handle())?;
            app.manage(watcher);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            agents::agents_list,
            dnd::paths_are_images,
            links::open_url,
            links::open_path,
            links::open_in_editor,
            session::session_spawn,
            session::session_write,
            session::session_resize,
            session::session_close,
            state::deck_state_load,
            state::deck_state_save,
            state::deck_state_quarantine,
            history::history_latest,
            history::history_exists,
            sessions::session_spawn_context,
            sessions::deck_log,
            worktree::worktree_inspect,
            worktree::worktree_suggest,
            worktree::worktree_probe,
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
