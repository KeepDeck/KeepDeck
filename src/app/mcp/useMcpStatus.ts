import { useEffect, useSyncExternalStore } from "react";
import type { McpStatus } from ".";
import { useAppRuntime } from "../runtimeContext";

/** The MCP transport's confirmed status (see [`McpStatus`]) — the bridge
 * every settings surface reads instead of re-deriving "the server is on"
 * from the setting.
 *
 * Mounting also asks the owner to bring its derived parts up to date. Two go
 * stale with nothing to notice: a refusal whose pane has closed, and a
 * connect lookup that never landed. Deciding what "up to date" means is the
 * owner's — this only says when someone started looking.
 */
export function useMcpStatus(): McpStatus {
  const { mcp } = useAppRuntime();
  useEffect(() => {
    mcp.refresh();
  }, [mcp]);
  return useSyncExternalStore(mcp.subscribe, mcp.status, mcp.status);
}
