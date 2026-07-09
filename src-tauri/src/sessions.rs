//! Per-agent spawn context (session identity v2, [F7]/[F8]).
//!
//! At spawn, KeepDeck arms each agent with a reporter (claude needs none for
//! a fresh id — it's assigned via `--session-id` — but the hook still reports
//! mid-life session swaps; codex gets a `SessionStart` hook, opencode a
//! plugin, both shipped inside KeepDeck and activated per invocation). The
//! reporter posts the session id back through the CLI bridge (`bridge.rs`);
//! this module only resolves the per-install constants the webview's spawn
//! plans need: the bridge inbox and each agent's ready-made hook arguments.
//! Bindings are exact by construction — the id comes from the pane's own
//! process, so parallel spawns (or agents run outside KeepDeck) can never
//! cross-bind. No timers anywhere.

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Per-install spawn-plan constants (mirrors the TS `SpawnPlanContext`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnContextDto {
    /// This run's bridge inbox — spawn plans advertise it (with the pane id
    /// and a per-spawn token) through the single `KEEPDECK_BRIDGE` env var.
    pub bridge_dir: String,
    /// Ready-made claude `--settings` args arming the SessionStart hook —
    /// how a mid-life `/clear` (a session swap) reaches KeepDeck.
    pub claude_hook_args: Option<Vec<String>>,
    /// Ready-made codex `-c` args enabling the SessionStart hook (config +
    /// trusted hash).
    pub codex_hook_args: Option<Vec<String>>,
    /// Absolute path of the opencode session-reporter plugin.
    pub opencode_plugin_path: Option<String>,
}

/// The spawn-plan context, resolved once at webview boot.
#[tauri::command]
pub fn session_spawn_context(app: AppHandle) -> Result<SpawnContextDto, String> {
    let dto = SpawnContextDto {
        // Managed at setup; absent only if the bridge failed to start, in
        // which case identity mechanisms are off ("" = unavailable).
        bridge_dir: app
            .try_state::<crate::bridge::Bridge>()
            .map(|b| b.run_dir.to_string_lossy().into_owned())
            .unwrap_or_default(),
        claude_hook_args: claude_hook_args(&app),
        codex_hook_args: codex_hook_args(&app),
        opencode_plugin_path: reporter_path(&app, "session-reporter.js"),
    };
    // A missing reporter here is why a pane later revives "fresh" instead of
    // resuming — flag it at the source.
    log::info!(
        "spawn-context: bridge={} claudeHook={} codexHook={} opencodePlugin={}",
        !dto.bridge_dir.is_empty(),
        dto.claude_hook_args.is_some(),
        dto.codex_hook_args.is_some(),
        dto.opencode_plugin_path.is_some(),
    );
    Ok(dto)
}

/// The shared hook script's shell command line, `/bin/sh`-explicit — bundling
/// may drop the exec bit — with the path single-quote escaped.
fn hook_command(app: &AppHandle) -> Option<String> {
    let script = reporter_path(app, "kd-session-hook.sh")?;
    Some(format!(
        "/bin/sh {}",
        keepdeck_history::codex_hook::shell_quote(&script)
    ))
}

/// The `--settings` args arming the claude SessionStart reporter. The inline
/// JSON MERGES with the user's settings (hooks merge per event; verified on
/// 2.1.198), and SessionStart fires on startup/resume/clear/compact — so a
/// mid-life `/clear` reports the pane's NEW session id. Built with serde,
/// never string-glued: print mode silently ignores malformed settings.
fn claude_hook_args(app: &AppHandle) -> Option<Vec<String>> {
    let command = hook_command(app)?;
    let settings = serde_json::json!({
        "hooks": {
            "SessionStart": [ { "hooks": [ { "type": "command", "command": command } ] } ]
        }
    });
    Some(vec!["--settings".into(), settings.to_string()])
}

/// The `-c` overrides arming the codex SessionStart reporter. On a codex
/// without hooks these overrides are inert (unknown `-c` keys are ignored),
/// so no version gate is needed; such a pane just stays unbound and revives
/// via latest-for-directory.
fn codex_hook_args(app: &AppHandle) -> Option<Vec<String>> {
    let command = hook_command(app)?;
    Some(keepdeck_history::codex_hook::cli_args(&command))
}

/// Absolute path of a reporter shipped in KeepDeck's resources, when present
/// (dev and bundle both resolve through the Resource base dir).
fn reporter_path(app: &AppHandle, name: &str) -> Option<String> {
    let path = app
        .path()
        .resolve(
            format!("resources/{name}"),
            tauri::path::BaseDirectory::Resource,
        )
        .ok()?;
    path.is_file().then(|| path.to_string_lossy().into_owned())
}
