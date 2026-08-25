//! Per-install spawn context (session identity v2, [F7]/[F8]).
//!
//! The per-agent identity mechanics (hook args, reporter injection) live in
//! the cli plugins; the host arms the bridge itself. All the webview needs
//! from here is where this run's bridge answers, and the directory it hands
//! panes — both resolved once at boot. Bindings
//! stay exact by construction — the id comes from the pane's own process,
//! so parallel spawns (or agents run outside KeepDeck) can never cross-bind.
//! No timers anywhere.

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Per-install spawn-plan constants (mirrors the TS `SpawnPlanContext`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnContextDto {
    /// This run's bridge directory — spawn plans advertise it (with the pane
    /// id and a per-spawn token) through the single `KEEPDECK_BRIDGE` env
    /// var. It carries the deck's doorbell and nothing else.
    pub bridge_dir: String,
    /// Where this run's bridge answers, advertised through the same var, and
    /// the only lane a reporter has. Empty means unavailable — and a pane is
    /// then armed with nothing rather than with a directory it cannot report
    /// through.
    pub bridge_url: String,
}

/// The spawn-plan context, resolved once at webview boot.
#[tauri::command]
pub fn session_spawn_context(app: AppHandle) -> Result<SpawnContextDto, String> {
    // Managed at setup; absent only if the bridge failed to start, in which
    // case identity mechanisms are off ("" / 0 = unavailable).
    let bridge = app.try_state::<crate::bridge::Bridge>();
    let dto = SpawnContextDto {
        // Both read from ONE state lookup: a dir without its port, or the
        // other way round, would be a half-armed bridge nobody declared.
        bridge_dir: bridge
            .as_ref()
            .map(|b| b.run_dir.to_string_lossy().into_owned())
            .unwrap_or_default(),
        bridge_url: bridge.as_ref().map(|b| b.url.clone()).unwrap_or_default(),
    };
    log::info!(
        "spawn-context: bridge={} url={}",
        !dto.bridge_dir.is_empty(),
        dto.bridge_url
    );
    Ok(dto)
}
