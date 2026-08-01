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
