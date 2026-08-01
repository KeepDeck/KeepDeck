// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `keepdeck --mcp-shim` is the stdio adapter MCP clients spawn — a pure
    // byte pump that must never boot Tauri, log, or touch the home beyond
    // the socket. Decided before anything else runs.
    if let Some(mode) = keepdeck_lib::mcp_shim_mode(std::env::args()) {
        std::process::exit(keepdeck_lib::run_mcp_shim(mode));
    }
    keepdeck_lib::run()
}
