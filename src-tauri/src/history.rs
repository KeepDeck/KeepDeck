//! Session-history delivery layer ([F7]/[F8]): the webview's window into the
//! agents' on-disk session stores, backed by the framework-free
//! `keepdeck-history` provider registry. Discovery only reads files/SQLite —
//! an agent CLI is never executed here (several launch a TUI when invoked
//! carelessly).

use keepdeck_history::SessionProviders;
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

/// A discovered session (mirrors the TS `HistoryHit`, camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryHitDto {
    /// The agent's own session id — what its resume flag accepts.
    pub id: String,
    /// Store mtime of the session, epoch milliseconds.
    pub modified_ms: u64,
}

fn providers() -> Option<SessionProviders> {
    let home = std::env::var_os("HOME")?;
    Some(SessionProviders::from_home(Path::new(&home)))
}

/// The most recent session of `agent` recorded for the working directory
/// `dir`, optionally only when written after `since_ms`. `None` means
/// "nothing found" — missing stores and unknown agents are not errors.
#[tauri::command]
pub fn history_latest(
    agent: String,
    dir: String,
    since_ms: Option<u64>,
) -> Option<HistoryHitDto> {
    let since = since_ms.map(|ms| UNIX_EPOCH + Duration::from_millis(ms));
    providers()?
        .latest_session(&agent, Path::new(&dir), since)
        .map(|s| HistoryHitDto {
            id: s.id,
            modified_ms: s
                .modified
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        })
}

/// Whether `agent`'s session `id` still exists for `dir` — pre-resume
/// validation, so a stale binding degrades instead of resuming into an error.
#[tauri::command]
pub fn history_exists(agent: String, id: String, dir: String) -> bool {
    providers().is_some_and(|p| p.session_exists(&agent, &id, Path::new(&dir)))
}

#[cfg(test)]
mod tests {
    use super::HistoryHitDto;

    // The webview narrows on this exact JSON shape (src/ipc/history.ts) — pin it.
    #[test]
    fn dto_serializes_camel_case() {
        let json = serde_json::to_value(HistoryHitDto {
            id: "uuid-1".into(),
            modified_ms: 1_234,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "id": "uuid-1", "modifiedMs": 1_234 }));
    }
}
