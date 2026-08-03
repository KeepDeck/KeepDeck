import { listen } from "@tauri-apps/api/event";

/**
 * Agent-status events: a pane's agent process reports its turn lifecycle
 * (turn started, waiting on the user, ended, failed) through the CLI
 * bridge — hook reporters armed at spawn. The Rust watcher passes the
 * payload through verbatim and emits this event. The constant mirrors
 * `AGENT_STATUS_EVENT` in src-tauri/src/bridge.rs.
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
