mod agents;
mod apps;
mod app_updater;
mod bridge;
mod clipboard;
mod codex_app_server;
mod containment;
mod dnd;
mod downloads;
mod fswatch;
mod head_watch;
mod kimi_usage;
mod links;
mod logging;
mod menu;
mod migration;
mod paths;
mod plugins_fs;
mod plugins_fs_write;
mod ports;
mod project_fs;
mod project_git;
mod session_tail;
mod session;
mod sessions;
mod skills;
mod voice;
mod history;
mod journal;
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
    /// Whether the updater plugin is configured — true only for release
    /// builds (the config lives in the tauri.release.conf.json overlay).
    /// The frontend keys its whole update flow off this flag.
    pub updater: bool,
}

impl AppInfo {
    fn current(updater: bool) -> Self {
        Self {
            name: "KeepDeck".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            updater,
        }
    }
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo::current(app.config().plugins.0.contains_key("updater"))
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
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
        .manage(history::HistoryIndex::default())
        .manage(session::SessionRegistry::default())
        .manage(worktree::RepoLocks::default())
        .manage(skills::SkillsLocks::default())
        .manage(head_watch::HeadWatchers::default())
        .manage(session_tail::UsageTails::default())
        .manage(codex_app_server::CodexAppServerManager::default())
        .manage(project_fs::ProjectFsWatchers::default())
        .manage(project_git::ProjectGitWatchers::default())
        .manage(downloads::DownloadRegistry::default())
        .manage(app_updater::AppUpdaterState::default())
        .manage(voice::VoiceState::default())
        .setup(move |app| {
            logging::install_panic_hook();
            logging::banner();
            // The updater's config (pubkey + endpoints) lives only in the
            // release overlay (tauri.release.conf.json); a dev build carries
            // no `plugins.updater` section and the plugin refuses to init
            // without one, so it is registered only when configured. The
            // frontend treats the plugin's absence as "updates disabled".
            if app.config().plugins.0.contains_key("updater") {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
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
            app_updater::app_update_check,
            app_updater::app_update_install,
            app_updater::app_update_discard,
            agents::agents_detect,
            apps::list_applications,
            clipboard::clipboard_image_to_temp,
            dnd::paths_are_images,
            downloads::download_start,
            downloads::download_cancel,
            downloads::download_exists,
            downloads::download_remove,
            downloads::plugin_adopt_legacy_downloads,
            links::open_url,
            links::open_path,
            links::open_path_with,
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
            state::usage_cache_load,
            state::usage_cache_save,
            journal::journal_load,
            journal::journal_append,
            journal::journal_compact,
            history::index_refs,
            history::index_upsert,
            history::index_prune,
            history::index_search,
            history::plugins_sqlite_query,
            plugins_fs_write::plugins_fs_write_mkdir,
            plugins_fs_write::plugins_fs_write_copy,
            plugins_fs_write::plugins_fs_write_file,
            plugins_fs_write::plugins_fs_write_append,
            skills::skills_list,
            skills::skills_save,
            skills::skills_delete,
            skills::skills_rename,
            skills::skills_stage,
            skills::skills_prune,
            skills::skills_disarm,
            ports::ports_allocate,
            plugins_fs::plugins_scan,
            plugins_fs::plugins_resolve_dir,
            plugins_fs::plugin_resource_path,
            plugins_fs::plugin_external_resource_path,
            project_fs::project_fs_read_dir,
            project_fs::project_fs_read_file,
            project_fs::project_fs_watch,
            project_fs::project_fs_unwatch,
            project_git::project_git_status,
            project_git::project_git_diff_file,
            project_git::project_git_history,
            project_git::project_git_branches,
            project_git::project_git_changed_files,
            project_git::project_git_watch,
            project_git::project_git_unwatch,
            sessions::session_spawn_context,
            voice::voice_engines,
            voice::voice_capture_start,
            voice::voice_capture_stop,
            voice::voice_capture_cancel,
            worktree::worktree_inspect,
            worktree::worktree_suggest,
            worktree::worktree_probe,
            worktree::worktree_branches,
            worktree::worktree_create,
            worktree::worktree_remove,
            head_watch::worktree_watch,
            head_watch::worktree_unwatch,
            session_tail::usage_watch_session_file,
            session_tail::usage_unwatch_session_file,
            session_tail::usage_find_codex_rollout,
            session_tail::usage_latest_codex_rollout,
            codex_app_server::codex_rate_limits_read,
            kimi_usage::kimi_usages_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_crate_identity() {
        let info = AppInfo::current(false);
        assert_eq!(info.name, "KeepDeck");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert!(!info.version.is_empty(), "version must not be empty");
        assert!(!info.updater, "dev builds must report the updater as absent");
    }
}
