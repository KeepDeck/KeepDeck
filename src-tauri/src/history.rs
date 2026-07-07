//! Session-history delivery layer ([F7]/[F8]): the webview's window into the
//! agents' on-disk session stores, backed by the framework-free
//! `keepdeck-history` provider registry. Discovery only reads files/SQLite —
//! an agent CLI is never executed here (several launch a TUI when invoked
//! carelessly).

use keepdeck_history::{Presence, SessionProviders};
use serde::Serialize;
use std::path::Path;

fn providers() -> Option<SessionProviders> {
    let home = std::env::var_os("HOME")?;
    Some(SessionProviders::from_home(Path::new(&home)))
}

/// Tri-state pre-resume validation (mirrors the TS `SessionPresence`): only
/// a definitive `absent` may drop a session binding — `unknown` means the
/// store couldn't answer and the binding must be kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceDto {
    Present,
    Absent,
    Unknown,
}

impl From<Presence> for PresenceDto {
    fn from(presence: Presence) -> Self {
        match presence {
            Presence::Present => Self::Present,
            Presence::Absent => Self::Absent,
            Presence::Unknown => Self::Unknown,
        }
    }
}

/// Whether `agent`'s session `id` is still in its store for `dir` —
/// pre-resume validation, so a stale binding degrades instead of resuming
/// into an error. No HOME = no store to ask = `unknown`. On the blocking
/// pool (store discovery reads files/SQLite — not main-thread work), and a
/// lost task degrades to `unknown` too.
#[tauri::command]
pub async fn history_presence(agent: String, id: String, dir: String) -> PresenceDto {
    tauri::async_runtime::spawn_blocking(move || {
        providers().map_or(PresenceDto::Unknown, |p| {
            p.session_presence(&agent, &id, Path::new(&dir)).into()
        })
    })
    .await
    .unwrap_or(PresenceDto::Unknown)
}

#[cfg(test)]
mod tests {
    use super::PresenceDto;

    // The webview narrows on these exact strings (SessionPresence) — pin them.
    #[test]
    fn presence_serializes_lowercase() {
        for (dto, expected) in [
            (PresenceDto::Present, "present"),
            (PresenceDto::Absent, "absent"),
            (PresenceDto::Unknown, "unknown"),
        ] {
            assert_eq!(serde_json::to_value(dto).unwrap(), serde_json::json!(expected));
        }
    }
}
