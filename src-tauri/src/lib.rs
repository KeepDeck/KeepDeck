mod agents;
mod apps;
mod app_updater;
mod artifacts;
mod bridge;
mod clipboard;
mod codex_app_server;
mod containment;
mod dnd;
mod downloads;
mod fswatch;
mod fs_names;
mod head_watch;
mod kimi_usage;
mod links;
mod logging;
mod mcp;
mod menu;
mod migration;
#[cfg(target_os = "macos")]
mod notify_identity;
mod paths;
mod plugins_fs;
mod plugins_fs_write;
mod plugins_sqlite;
mod ports;
mod project_fs;
mod project_git;
mod session_tail;
mod session;
mod sessions;
mod roles;
mod skills;
mod voice;
mod history;
mod journal;
mod state;
mod jsonl_log;
mod usage_history;
mod usage_reports;
mod worktree;
mod worktree_arm;

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

// The shim entry points main() consults before booting Tauri (mcp/shim.rs).
pub use mcp::shim::{run as run_mcp_shim, shim_mode as mcp_shim_mode};

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
        .manage(artifacts::ArtifactsState::new())
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
        .manage(mcp::server::McpServer::default())
        .manage(mcp::bridge::McpBridge::default())
        .setup(move |app| {
            logging::install_panic_hook();
            logging::banner();
            // The notification stack gets exactly one chance to resolve who we
            // are and takes it lazily, on the first banner (see
            // `notify_identity`). Tauri has ALREADY built the config-declared
            // window and its webview by the time this closure runs, so being
            // early in `setup` is not what keeps us ahead of that first
            // banner — the main thread simply has not yielded to the run loop
            // yet, so no frontend code has executed. Anything added above this
            // line that pumps the run loop (a modal, a main-thread drain)
            // would let the webview reach `sendNotification` first and burn
            // the attempt.
            #[cfg(target_os = "macos")]
            notify_identity::prepare(&app.config().identifier);
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
            let gate_app = app.handle().clone();
            app.manage(skills::GateRegistry::new(move || {
                gate_app
                    .state::<artifacts::ArtifactsState>()
                    .is_claimed()
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            app_updater::app_update_check,
            app_updater::app_update_install,
            app_updater::app_update_discard,
            agents::agents_detect,
            agents::agents_probe_version,
            artifacts::artifacts_enable,
            artifacts::artifacts_disable,
            artifacts::artifact_publish,
            artifacts::artifact_list,
            artifacts::artifact_read,
            artifacts::artifact_delete,
            artifacts::artifact_resolve_urls,
            artifacts::artifact_drop_workspace,
            bridge::bridge_nudge,
            bridge::bridge_pane_dir,
            bridge::bridge_reply,
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
            mcp::mcp_enable,
            mcp::mcp_disable,
            mcp::mcp_respond,
            mcp::mcp_connection_command,
            mcp::arming::mcp_arm,
            mcp::arming::mcp_disarm,
            mcp::arming::mcp_prune,
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
            state::settings_snapshot,
            state::usage_cache_load,
            state::usage_cache_save,
            state::achievements_load,
            state::achievements_save,
            usage_history::usage_history_load,
            usage_history::usage_history_append,
            usage_history::usage_history_compact,
            usage_reports::usage_reports_load,
            usage_reports::usage_reports_append,
            usage_reports::usage_reports_compact,
            journal::journal_load,
            journal::journal_append,
            journal::journal_compact,
            history::index_refs,
            history::index_upsert,
            history::index_prune,
            history::index_search,
            history::index_lookup,
            plugins_sqlite::plugins_sqlite_query,
            plugins_fs_write::plugins_fs_write_mkdir,
            plugins_fs_write::plugins_fs_write_copy,
            plugins_fs_write::plugins_fs_write_file,
            plugins_fs_write::plugins_fs_write_append,
            skills::skills_list,
            skills::skills_save,
            skills::skills_delete,
            skills::skills_rename,
            skills::skills_stage,
            skills::skills_arm,
            skills::skills_prune,
            skills::skills_disarm,
            roles::roles_list,
            roles::roles_save,
            roles::roles_delete,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // The app is going — take the agents with it.
        //
        // Nothing ever did this. Dropping the window closes each PTY, which
        // hangs up the terminal and nothing more: a CLI that owns its own
        // children lives on, orphaned, holding whatever it held. It is
        // invisible until the next launch, when codex finds "an active
        // writer" on the rollout it wants to resume — the writer being the
        // codex the last run left behind.
        //
        // Both events, because either can be the last one this process sees:
        // `ExitRequested` on the ordinary quit path, `Exit` when the run loop
        // is torn down under us. `shutdown` empties the registry, so whichever
        // comes second finds nothing to do.
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                app.state::<session::SessionRegistry>()
                    .shutdown(keepdeck_pty::STOP_GRACE);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn app_info_reports_crate_identity() {
        let info = AppInfo::current(false);
        assert_eq!(info.name, "KeepDeck");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert!(!info.version.is_empty(), "version must not be empty");
        assert!(!info.updater, "dev builds must report the updater as absent");
    }

    // ── The wiring pin ──────────────────────────────────────────────
    //
    // The composition root is the one seam NO layer test reaches: cargo
    // tests call command fns directly (State resolution never runs) and
    // the TS suites mock the ipc boundary. A1 was exactly this —
    // `manage(ArtifactsStore)` while every command waited on
    // `State<ArtifactsState>` — runtime-dead, silently disarming every
    // agent's skills on every spawn, invisible to both suites
    // (learning/state-signature-reviews-include-manage-inventory).
    //
    // The pin scans OUR OWN SOURCE as text: every `State<T>` parameter
    // anywhere under src/ must name a type the app manages. It fails
    // loud on surprises (a parse that finds nothing is a failure, not a
    // pass), so new syntax degrades into noise, never silence.
    //
    // Over-matching every fn signature — not just #[tauri::command] —
    // is deliberate: the safe direction. A non-command `State<T>` is
    // either managed (fine) or dead code the pin surfaces for free.

    /// Types managed NOT as a `Type::new()` literal in the builder
    /// chain but through a let binding in `setup` — the scan cannot
    /// resolve those; each entry names its start-injected type.
    /// KISS: explicit and reviewed beats binding resolution machinery.
    const SETUP_MANAGED_TYPES: &[&str] = &[
        // `let bridge = bridge::start(app.handle())?; app.manage(bridge);`
        "Bridge",
        // `app.manage(skills::GateRegistry::new(...));`
        "GateRegistry",
    ];

    /// The final path segment of a type expression: `crate::artifacts::
    /// ArtifactsState` → `ArtifactsState`; bare names pass through.
    fn final_segment(ty: &str) -> &str {
        ty.rsplit("::").next().unwrap_or(ty)
    }

    /// Every type expression appearing in a `State<...>` parameter in
    /// `src`, both spellings (`State<'_, T>` and `State<T>`),
    /// multiline-safe (signatures wrap across lines).
    fn state_params(src: &str) -> Vec<String> {
        let mut found = Vec::new();
        let bytes = src.as_bytes();
        let mut i = 0;
        while let Some(rel) = src[i..].find("State<") {
            let start = i + rel;
            // Skip string-ish false positives the cheap way: none exist
            // in the sources (no `State<` inside literals today); the
            // loud-failure rule below catches drift into one.
            let mut depth = 0usize;
            let mut j = start + "State".len();
            let mut inner = String::new();
            let mut closed = false;
            while j < bytes.len() {
                match bytes[j] {
                    b'<' => {
                        depth += 1;
                        if depth == 1 {
                            j += 1;
                            continue;
                        }
                    }
                    b'>' => {
                        depth -= 1;
                        if depth == 0 {
                            closed = true;
                            break;
                        }
                    }
                    _ => {}
                }
                if depth >= 1 {
                    inner.push(bytes[j] as char);
                }
                j += 1;
            }
            assert!(
                closed,
                "wiring pin: unbalanced State<…> — new syntax? fail loud, not silent"
            );
            // `<'_, T>` → strip the lifetime to `T`; `State<crate::x::T>`
            // keeps its path for final_segment() to normalize.
            let inner = inner.trim();
            let ty = inner
                .strip_prefix("'_, ")
                .or_else(|| inner.strip_prefix("'_ ,"))
                .unwrap_or(inner)
                .trim();
            if !ty.is_empty() && !ty.starts_with('\'') {
                found.push(ty.to_string());
            }
            i = start + "State".len();
        }
        found
    }

    /// Production source with `#[cfg(test)] mod … { … }` blocks removed:
    /// tests quote the hunted syntax itself, and State resolution is a
    /// production property. Brace-matched (strings containing braces
    /// would fool it — none do in test-mod headers; loud failures
    /// guard the edges).
    fn strip_test_mods(src: &str) -> String {
        let mut out = String::with_capacity(src.len());
        let mut rest = src;
        while let Some(rel) = rest.find("#[cfg(test)]") {
            let cut = rel + "#[cfg(test)]".len();
            out.push_str(&rest[..cut]);
            rest = &rest[cut..];
            // Skip attributes/comments to the `mod` keyword.
            if let Some(mod_rel) = rest.find("mod ") {
                let header_end = mod_rel + "mod ".len();
                out.push_str(&rest[..header_end]);
                rest = &rest[header_end..];
                // The mod name, then the brace-opened body.
                if let Some(brace) = rest.find('{') {
                    let name = &rest[..brace];
                    if name.trim_start_matches(|c: char| c.is_alphanumeric() || c == '_')
                        .trim()
                        .is_empty()
                    {
                        out.push_str(&rest[..=brace]);
                        rest = &rest[brace + 1..];
                        let mut depth = 1usize;
                        let mut k = 0;
                        while k < rest.len() && depth > 0 {
                            match rest.as_bytes()[k] {
                                b'{' => depth += 1,
                                b'}' => depth -= 1,
                                _ => {}
                            }
                            k += 1;
                        }
                        out.push_str("/* tests stripped */}");
                        rest = &rest[k..];
                        continue;
                    }
                }
            }
            // Not a mod-block shape (e.g. an attribute on a fn): keep
            // scanning from after the attribute, cutting nothing.
            out.push_str(rest);
            break;
        }
        out.push_str(rest);
        out
    }

    /// SOURCE-TREE ABSENCE: this walks only `src/**/*.rs`; it does not claim
    /// to inspect every file under `src-tauri` or code outside the tree. No
    /// source in this scanned tree may set or remove KEEPDECK_HOME. Test homes
    /// are a fresh tmp dir per test by construction (paths.rs); the env
    /// override is a production mechanism nobody mutates. This scan — the
    /// wiring-pin pattern — makes an in-tree setter unreachable, which is what
    /// keeps the keepdeck_home() tripwire's blast radius fair: every trip
    /// source that can actually reach it (a shell export, out-of-tree
    /// mutation) reports honest process state and deserves its red.
    #[test]
    fn nothing_sets_or_removes_keepdeck_home() {
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders: Vec<String> = Vec::new();
        let mut stack = vec![src_dir.clone()];
        let mut scanned = 0usize;
        while let Some(dir) = stack.pop() {
            let entries = std::fs::read_dir(&dir)
                .unwrap_or_else(|e| panic!("home pin: reading {dir:?}: {e}"));
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    scanned += 1;
                    let src = std::fs::read_to_string(&path)
                        .unwrap_or_else(|e| panic!("home pin: reading {path:?}: {e}"));
                    // The matcher is intentionally same-line and literal: a
                    // cheap source pin, not a Rust parser. A direct negative
                    // setter test cannot live here because this scan reads
                    // its own source and would report that test as a finding.
                    for (idx, line) in src.lines().enumerate() {
                        if line.contains("env::set_var")
                            || line.contains("env::remove_var")
                        {
                            if line.contains("KEEPDECK_HOME") {
                                offenders.push(format!(
                                    "{}:{}: {}",
                                    path.file_name().unwrap().to_string_lossy(),
                                    idx + 1,
                                    line.trim()
                                ));
                            }
                        }
                    }
                }
            }
        }
        assert!(scanned > 50, "home pin: scanned too few files — the walk broke, fail loud");
        assert!(
            offenders.is_empty(),
            "KEEPDECK_HOME must never be set or removed in-tree: test homes \
             are a fresh tmp dir per test by construction (paths.rs). To \
             change the home, change paths.rs, not the env.\n  {}",
            offenders.join("\n  ")
        );
    }

    #[test]
    fn every_state_param_is_managed() {
        let lib_src = include_str!("lib.rs");

        // The managed set: builder-chain `.manage(Type…)` literals +
        // the setup allowlist.
        let mut managed: Vec<String> = Vec::new();
        for line in lib_src.lines() {
            if let Some(rest) = line.trim().strip_prefix(".manage(") {
                let arg = rest.trim_end_matches(')').trim();
                // `Type::new()` / `Type::default()` / `Type::name(args)`:
                // the type is everything before the final `::`.
                if let Some(pos) = arg.rfind("::") {
                    managed.push(final_segment(&arg[..pos]).to_string());
                } else {
                    panic!(
                        "wiring pin: .manage({arg}) is not a Type::… literal — \
                         add it to SETUP_MANAGED_TYPES or teach the scan"
                    );
                }
            }
        }
        managed.extend(SETUP_MANAGED_TYPES.iter().map(|s| s.to_string()));
        assert!(
            !managed.is_empty(),
            "wiring pin: no .manage( lines found — scan broke, fail loud"
        );

        // The consumer set: every State<T> across src/**.rs.
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut consumers: Vec<(String, String)> = Vec::new(); // (type, file)
        let mut stack = vec![src_dir.clone()];
        while let Some(dir) = stack.pop() {
            let entries = std::fs::read_dir(&dir)
                .unwrap_or_else(|e| panic!("wiring pin: reading {dir:?}: {e}"));
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let src = std::fs::read_to_string(&path)
                        .unwrap_or_else(|e| panic!("wiring pin: reading {path:?}: {e}"));
                    // Production code only: test modules quote the very
                    // syntax this pin hunts (this test's own body
                    // included), and State resolution is a runtime
                    // property of production signatures.
                    let prod = strip_test_mods(&src);
                    for ty in state_params(&prod) {
                        consumers.push((
                            final_segment(&ty).to_string(),
                            path.file_name().unwrap().to_string_lossy().into_owned(),
                        ));
                    }
                }
            }
        }
        assert!(
            !consumers.is_empty(),
            "wiring pin: no State<…> params found — scan broke, fail loud"
        );

        let mut unmanaged: Vec<String> = consumers
            .iter()
            .filter(|(ty, _)| !managed.contains(ty))
            .map(|(ty, file)| format!("{ty} (in {file})"))
            .collect();
        if !unmanaged.is_empty() {
            unmanaged.sort();
            panic!(
                "wiring pin: State<…> of unmanaged types — the A1 class. \
                 Manage them in lib.rs or fix the signature:\n  {}",
                unmanaged.join("\n  ")
            );
        }
    }
}
