//! Agent catalog delivery layer: exposes the installed-agent list to the webview.
//!
//! Clean-architecture boundary — this adapter depends on the `keepdeck-agents`
//! domain crate (catalog + detection), never the reverse. It maps the
//! framework-free [`keepdeck_agents::AgentStatus`] to a serde DTO and serves it
//! over the `agents_list` command.

use keepdeck_agents::AgentStatus;
use serde::Serialize;

/// Agent entry sent to the webview (mirrors the TS `AgentInfo`, camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDto {
    /// Stable id (`"claude"`), mirrored by the frontend `AgentType` union.
    pub id: String,
    /// Human-facing label (`"Claude Code"`).
    pub label: String,
    /// Command to spawn (passed back to `session_spawn`).
    pub command: String,
    /// Whether the agent's binary resolves on the augmented PATH.
    pub installed: bool,
    /// Absolute path of the resolved binary, when installed.
    pub path: Option<String>,
}

impl From<AgentStatus> for AgentDto {
    fn from(status: AgentStatus) -> Self {
        Self {
            id: status.id,
            label: status.label,
            command: status.command,
            installed: status.installed,
            // Lossy is fine for display; agent binaries live at UTF-8 paths.
            path: status.path.map(|p| p.to_string_lossy().into_owned()),
        }
    }
}

/// List the catalog agents, each annotated with whether it's installed. The
/// frontend renders installed agents (and falls back to the full list if none
/// resolve). Detection is presence-only and cheap — safe to call per form open.
#[tauri::command]
pub fn agents_list() -> Vec<AgentDto> {
    keepdeck_agents::list().into_iter().map(Into::into).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn maps_status_to_dto_camel_case_path() {
        let dto = AgentDto::from(AgentStatus {
            id: "claude".into(),
            label: "Claude Code".into(),
            command: "claude".into(),
            installed: true,
            path: Some(PathBuf::from("/opt/homebrew/bin/claude")),
        });
        assert_eq!(dto.path.as_deref(), Some("/opt/homebrew/bin/claude"));

        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["installed"], true);
        assert_eq!(json["command"], "claude");
        // camelCase / null path round-trip for an uninstalled agent.
        let missing = AgentDto::from(AgentStatus {
            id: "codex".into(),
            label: "Codex".into(),
            command: "codex".into(),
            installed: false,
            path: None,
        });
        let json = serde_json::to_value(&missing).unwrap();
        assert_eq!(json["path"], serde_json::Value::Null);
    }
}
