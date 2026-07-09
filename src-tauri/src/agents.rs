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
    /// CLI args placed before a session id to resume it ([F8]) —
    /// `["--resume"]` for claude, `["resume"]` for codex, `["-s"]` for opencode.
    pub resume_prefix: Vec<String>,
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
            resume_prefix: status
                .resume_prefix
                .iter()
                .map(|s| s.to_string())
                .collect(),
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

/// Install status of one requested binary name — the generic detection agent
/// PLUGINS resolve their declared `detect.bin` through (mirrors the TS
/// `BinStatus`, camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinStatusDto {
    pub bin: String,
    pub installed: bool,
    /// Absolute path of the resolved binary, when installed.
    pub path: Option<String>,
}

/// Detect which of the requested binaries resolve — on the SAME augmented
/// PATH the PTY spawn uses, so "detected" == "spawnable" stays true by
/// construction. Presence-only and cheap, safe to call per form open.
#[tauri::command]
pub fn agents_detect(bins: Vec<String>) -> Vec<BinStatusDto> {
    detect_bins(bins, keepdeck_env::augmented_path())
}

fn detect_bins(bins: Vec<String>, path: &std::ffi::OsStr) -> Vec<BinStatusDto> {
    bins.into_iter()
        .map(|bin| {
            let found = keepdeck_env::find_program(&bin, path);
            BinStatusDto {
                installed: found.is_some(),
                // Lossy is fine for display; agent binaries live at UTF-8 paths.
                path: found.map(|p| p.to_string_lossy().into_owned()),
                bin,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn detects_requested_bins_on_the_given_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("kd-fake-agent");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let statuses = detect_bins(
            vec!["kd-fake-agent".into(), "kd-absent-agent".into()],
            dir.path().as_os_str(),
        );
        assert_eq!(statuses.len(), 2);
        assert!(statuses[0].installed);
        assert_eq!(statuses[0].path.as_deref(), Some(bin.to_str().unwrap()));
        assert!(!statuses[1].installed);
        assert_eq!(statuses[1].path, None);

        // The wire shape the webview reads — pin the camelCase field.
        let json = serde_json::to_value(&statuses[0]).unwrap();
        assert_eq!(json["bin"], "kd-fake-agent");
        assert_eq!(json["installed"], true);
    }

    #[test]
    fn maps_status_to_dto_camel_case_path() {
        let dto = AgentDto::from(AgentStatus {
            id: "claude".into(),
            label: "Claude Code".into(),
            command: "claude".into(),
            installed: true,
            path: Some(PathBuf::from("/opt/homebrew/bin/claude")),
            resume_prefix: &["--resume"],
        });
        assert_eq!(dto.path.as_deref(), Some("/opt/homebrew/bin/claude"));

        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["installed"], true);
        assert_eq!(json["command"], "claude");
        // The resume recipe reaches the wire camelCased ([F8]).
        assert_eq!(json["resumePrefix"], serde_json::json!(["--resume"]));
        // camelCase / null path round-trip for an uninstalled agent.
        let missing = AgentDto::from(AgentStatus {
            id: "codex".into(),
            label: "Codex".into(),
            command: "codex".into(),
            installed: false,
            path: None,
            resume_prefix: &["resume"],
        });
        let json = serde_json::to_value(&missing).unwrap();
        assert_eq!(json["path"], serde_json::Value::Null);
    }
}
