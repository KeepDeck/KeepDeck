import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The MCP socket's webview leg. A socket client's request line arrives as a
 * `deck://mcp/request` event; the answer goes back through `mcp_respond`,
 * where the parked connection thread picks it up by correlation id. The
 * constant mirrors `MCP_REQUEST_EVENT` in src-tauri/src/mcp/bridge.rs.
 */
export const MCP_REQUEST_EVENT = "deck://mcp/request";

/** Mirrors the Rust `McpRequest` (camelCase). */
export interface McpRequest {
  id: number;
  line: string;
  /** What the connection introduced itself as, unresolved — null for one
   * that said nothing (a server the user wired up by hand). */
  client?: string | null;
}

/** Subscribe to socket requests; resolves to the unlisten function. */
export function onMcpRequest(
  handler: (request: McpRequest) => void,
): Promise<() => void> {
  return listen<McpRequest>(MCP_REQUEST_EVENT, (event) => handler(event.payload));
}

/** Return a request's reply line to its parked socket connection. */
export async function respondMcp(id: number, reply: string): Promise<void> {
  await invoke("mcp_respond", { id, reply });
}
