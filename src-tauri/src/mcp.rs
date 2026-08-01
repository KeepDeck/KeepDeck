//! The MCP feature's front door: the four Tauri commands, and the ONLY
//! place the transport's parts are wired together — the socket lifecycle
//! ([`crate::mcp_server`]), the webview bridge ([`crate::mcp_bridge`]) and
//! the shim's flag ([`crate::mcp_shim`]). The parts never import each
//! other's IMPLEMENTATIONS — the bridge depends only on the server's
//! `LineHandler` port type — so each stays testable alone, and a future
//! second transport (or a per-connection identity handler) edits this
//! file, not them.

use std::path::PathBuf;

use tauri::{Manager, State};

use crate::mcp_bridge::{self, McpBridge};
use crate::mcp_server::McpServer;
use crate::mcp_shim::SHIM_FLAG;

/// A missing home means no persistence environment at all — the transport
/// refuses to run rather than invent a location.
fn socket_path() -> Result<PathBuf, String> {
    crate::paths::mcp_socket()
        .ok_or_else(|| "no home directory to hold the MCP socket".to_string())
}

/// Builds before the socket moved into `mcp/` left a `<home>/mcp.sock`
/// behind. Best-effort tidy, and only when nothing answers on it — an
/// older build still serving its own socket is left alone.
fn sweep_legacy_socket() {
    let Some(legacy) = crate::paths::keepdeck_home().map(|home| home.join("mcp.sock")) else {
        return;
    };
    if std::fs::symlink_metadata(&legacy).is_ok()
        && std::os::unix::net::UnixStream::connect(&legacy).is_err()
    {
        let _ = std::fs::remove_file(&legacy);
    }
}

#[tauri::command(async)]
pub fn mcp_enable(app: tauri::AppHandle, server: State<McpServer>) -> Result<String, String> {
    sweep_legacy_socket();
    let path = socket_path()?;
    let served = server.enable(&path, mcp_bridge::webview_handler(app))?;
    log::info!("mcp: socket up at {}", served.display());
    Ok(served.display().to_string())
}

#[tauri::command(async)]
pub fn mcp_disable(server: State<McpServer>) {
    server.disable();
    log::info!("mcp: socket down");
}

#[tauri::command]
pub fn mcp_respond(bridge: State<McpBridge>, id: u64, reply: String) {
    if !bridge.resolve(id, reply) {
        log::debug!("mcp: reply {id} arrived after its request was abandoned");
    }
}

/// The stdio invocation an MCP client spawns to reach the deck — command
/// and args SEPARATELY, because that is the shape client configs take (a
/// concatenated string breaks the moment the install path holds a space).
/// It names THIS binary and THIS socket explicitly: the shim has a
/// default-path fallback, but that resolves from the CLIENT's environment —
/// a shell that sets XDG_CONFIG_HOME (or KEEPDECK_HOME) would derive a
/// different home than the Finder-launched app and connect to nothing.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnection {
    pub command: String,
    pub args: Vec<String>,
}

#[tauri::command]
pub fn mcp_connection_command(app: tauri::AppHandle) -> Result<McpConnection, String> {
    let binary = tauri::process::current_binary(&app.env()).map_err(|e| e.to_string())?;
    Ok(McpConnection {
        command: binary.display().to_string(),
        args: vec![SHIM_FLAG.to_string(), socket_path()?.display().to_string()],
    })
}
