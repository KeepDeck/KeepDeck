import { invoke } from "@tauri-apps/api/core";

/** Bring the MCP socket up (idempotent). Resolves to the socket path.
 * Throws on failure — the policy layer decides how loudly to react. */
export async function mcpEnable(): Promise<string> {
  return await invoke<string>("mcp_enable");
}

/** Tear the MCP socket down: stop accepting, disconnect every client,
 * remove the file. Idempotent. */
export async function mcpDisable(): Promise<void> {
  await invoke("mcp_disable");
}

/** The stdio command MCP clients spawn to reach the deck (the app binary in
 * shim mode) — what the settings page offers for copy-paste. */
export async function mcpConnectionCommand(): Promise<string> {
  return await invoke<string>("mcp_connection_command");
}
