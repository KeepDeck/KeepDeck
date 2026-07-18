import { invoke } from "@tauri-apps/api/core";
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

/** Follow a pane's session file in the given dialect (codex rollout / kimi
 * wire); its usage events arrive as usage reports carrying `token`.
 * Idempotent per pane — a rebind replaces the old tail. */
export function watchSessionFile(
  paneId: string,
  path: string,
  token: string,
  format: "codex" | "kimi-wire",
): Promise<void> {
  return invoke("usage_watch_session_file", { paneId, path, token, format });
}

/** Stop following a pane's session file (pane closed / workspace gone). */
export function unwatchSessionFile(paneId: string): Promise<void> {
  return invoke("usage_unwatch_session_file", { paneId });
}

/** One read-only GET of kimi's account usages document (the polled limits
 * source — kimi keeps no rate windows on disk). Body rides back opaque;
 * the kimi plugin's normalizer owns its schema. */
export function fetchKimiUsages(): Promise<string> {
  return invoke("kimi_usages_fetch");
}

/** Resolve a codex session's rollout path by its recorded id — the fallback
 * for TUI resumes, where codex fires no SessionStart hook and no binding
 * carries the path (observed on 0.144.5). */
export function findCodexRollout(sessionId: string): Promise<string | null> {
  return invoke("usage_find_codex_rollout", { sessionId });
}
