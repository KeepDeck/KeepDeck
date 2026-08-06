import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

/**
 * Agent-status events: a pane's agent process reports its turn lifecycle
 * (turn started, waiting on the user, ended, failed) through the CLI
 * bridge — hook reporters armed at spawn. The Rust watcher passes the
 * payload through verbatim and emits this event. The constant mirrors
 * `AGENT_STATUS_EVENT` in src-tauri/src/bridge/wire.rs.
 */
export const AGENT_STATUS_EVENT = "deck://agent/status";

/** Mirrors the Rust `Report` wire shape (camelCase). The payload is opaque here —
 * the per-agent status normalizers own its schema; `token` is the per-spawn
 * bridge secret verified against the pane's spawn plan. */
export interface AgentStatusReportEvent {
  paneId: string;
  token: string;
  payload: unknown;
}

/** Subscribe to status reports; resolves to the unlisten function. */
export function onAgentStatus(
  handler: (report: AgentStatusReportEvent) => void,
): Promise<() => void> {
  return listen<AgentStatusReportEvent>(AGENT_STATUS_EVENT, (event) =>
    handler(event.payload),
  );
}

/**
 * Answer a hook that is waiting on the bridge's run directory.
 *
 * `body` is what that hook will PRINT verbatim — its own CLI's hook-output
 * schema, rendered by that agent's plugin. An empty body is a real answer
 * and the common one: it lets a waiting hook stop waiting immediately
 * instead of sitting out its whole timeout on every turn that had no mail.
 *
 * Fire and forget by design. A reply that cannot be written leaves the hook
 * to time out, which every CLI reads as "the hook had nothing to add" —
 * the recoverable direction, and the same one the bridge chooses everywhere
 * else.
 */
export function replyToBridgeHook(id: string, body: string): void {
  void invoke("bridge_reply", { id, body }).catch(() => {});
}
