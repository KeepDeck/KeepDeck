import { useSyncExternalStore } from "react";
import type { McpStatus } from "./mcpService";
import { useAppRuntime } from "./runtimeContext";

/** The MCP transport's confirmed status (see [`McpStatus`]) — the bridge
 * every settings surface reads instead of re-deriving "the server is on"
 * from the setting. */
export function useMcpStatus(): McpStatus {
  const { mcp } = useAppRuntime();
  return useSyncExternalStore(mcp.subscribe, mcp.status, mcp.status);
}
