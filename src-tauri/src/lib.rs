mod agents;
mod bridge;
mod clipboard;
mod dnd;
mod fswatch;
mod head_watch;
mod links;
mod logging;
mod menu;
mod migration;
mod paths;
mod plugins_fs;
mod ports;
mod project_fs;
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
    // Trim past runs' log files before the plugin opens this run's own.
    let collected = logging::collect_garbage();
    tauri::Builder::default()
        .plugin(logging::plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Serves installed EXTERNAL plugins' own files under their own host —
        // `kdplugin://<plugin-id>/<path>` — so each plugin is its own origin.
        // Logic lives in `plugins_fs`; this closure only supplies the real
        // plugins root and the requesting webview's origin.
        .register_uri_scheme_protocol(plugins_fs::EXTERNAL_PLUGIN_SCHEME, |ctx, request| {
            let origin = plugins_fs::window_origin(ctx.app_handle(), ctx.webview_label());
            plugins_fs::handle_request(plugins_fs::plugins_root().as_deref(), &origin, &request)
        })
        .menu(menu::build)
        .on_menu_event(|app, event| menu::handle_event(app, event.id().as_ref()))
        .manage(session::SessionRegistry::default())
        .manage(worktree::RepoLocks::default())
        .manage(head_watch::HeadWatchers::default())
        .manage(project_fs::ProjectFsWatchers::default())
        .setup(move |app| {
            logging::install_panic_hook();
            logging::banner();
            if collected > 0 {
                log::info!("log gc: removed {collected} old file(s)");
            }
            // Image pastes leave temp PNGs a pane's CLI reads asynchronously —
            // they can only be reaped at the NEXT startup, here.
            clipboard::sweep_stale_clipboard_files();
            // Adopt state a legacy install left in the identifier-keyed
            // dirs — before the webview boots and asks for the deck.
            migration::run(app.handle());
            // The CLI bridge: agents report their session ids through this
            // run's inbox; the lock and watcher live as managed state for
            // the app's lifetime.
            let bridge = bridge::start(app.handle())?;
            app.manage(bridge);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            agents::agents_detect,
            clipboard::clipboard_image_to_temp,
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
            state::settings_load,
            state::settings_save,
            state::settings_quarantine,
            ports::ports_allocate,
            plugins_fs::plugins_scan,
            plugins_fs::plugins_resolve_dir,
            plugins_fs::plugin_resource_path,
            project_fs::project_fs_read_dir,
            project_fs::project_fs_read_file,
            project_fs::project_fs_watch,
            project_fs::project_fs_unwatch,
            sessions::session_spawn_context,
            worktree::worktree_inspect,
            worktree::worktree_suggest,
            worktree::worktree_probe,
            worktree::worktree_branches,
            worktree::worktree_create,
            worktree::worktree_remove,
            head_watch::worktree_watch,
            head_watch::worktree_unwatch,
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
