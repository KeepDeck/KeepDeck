import { listen } from "@tauri-apps/api/event";

/**
 * Usage-report events: a pane's agent process reports rate-limit windows,
 * tokens and cost through the CLI bridge (statusLine script / reporter armed
 * at spawn); the Rust watcher passes the payload through verbatim and emits
 * this event. The constant mirrors `USAGE_REPORT_EVENT` in
 * src-tauri/src/bridge.rs.
 */
export const USAGE_REPORT_EVENT = "deck://usage/report";

/** Mirrors the Rust `UsageReport` (camelCase). The payload is opaque here —
 * the per-agent normalizers in `src/domain/usage` own its schema; `token`
 * is the per-spawn bridge secret verified against the pane's spawn plan. */
export interface UsageReportEvent {
  paneId: string;
  token: string;
  payload: unknown;
}

/** Subscribe to usage reports; resolves to the unlisten function. */
export function onUsageReport(
  handler: (report: UsageReportEvent) => void,
): Promise<() => void> {
  return listen<UsageReportEvent>(USAGE_REPORT_EVENT, (event) =>
    handler(event.payload),
  );
}
