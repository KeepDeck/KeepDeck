import { listen } from "@tauri-apps/api/event";
import type { AgentStatusReportEvent } from "./status";

/**
 * Companion hellos: an in-process reporter (a mod, a CLI plugin) announcing
 * itself once from inside the pane's agent process. The bridge passes the
 * payload through like any report. The constant mirrors
 * `COMPANION_HELLO_EVENT` in src-tauri/src/bridge/wire.rs.
 */
export const COMPANION_HELLO_EVENT = "deck://companion/hello";

/** Subscribe to companion hellos; resolves to the unlisten function. */
export function onCompanionHello(
  handler: (report: AgentStatusReportEvent) => void,
): Promise<() => void> {
  return listen<AgentStatusReportEvent>(COMPANION_HELLO_EVENT, (event) =>
    handler(event.payload),
  );
}
