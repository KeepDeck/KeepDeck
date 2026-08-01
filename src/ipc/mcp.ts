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

/** Mirrors the Rust `McpConnection`: the stdio invocation an MCP client
 * spawns to reach the deck — command and args SEPARATELY, the shape client
 * configs take (one concatenated string breaks on paths with spaces). */
export interface McpConnection {
  command: string;
  args: string[];
}

/** The connect invocation for this install (the app binary in shim mode). */
export async function mcpConnectionCommand(): Promise<McpConnection> {
  return await invoke<McpConnection>("mcp_connection_command");
}
