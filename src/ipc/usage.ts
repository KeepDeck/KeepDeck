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

/** Follow a pane's session file in the given dialect (Claude transcript,
 * Codex rollout, or Kimi wire); usage events arrive as reports carrying `token`.
 * Idempotent per pane — a rebind replaces the old tail. */
export function watchSessionFile(
  paneId: string,
  path: string,
  token: string,
  format: "claude" | "codex" | "kimi-wire",
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

/** Read Codex account limits through KeepDeck's shared, lazily-lived
 * official app-server process. Body rides back opaque so the Codex plugin,
 * not the host transport, owns the version-specific response schema.
 * `sourceAt` is captured by native immediately before the actual JSON-RPC
 * write — after a cold app-server has initialized. */
export interface CodexRateLimitsRead {
  body: string;
  sourceAt: number;
}

export function fetchCodexRateLimits(): Promise<CodexRateLimitsRead> {
  return invoke("codex_rate_limits_read");
}

/** Resolve a codex session's rollout path by its recorded id — the fallback
 * for TUI resumes, where codex fires no SessionStart hook and no binding
 * carries the path (observed on 0.144.5). */
export function findCodexRollout(sessionId: string): Promise<string | null> {
  return invoke("usage_find_codex_rollout", { sessionId });
}

/** Mirrors the Rust `LatestRollout`: the newest on-disk usage event, its
 * source time when available, and the file-mtime fallback. */
export interface LatestCodexRollout {
  event: unknown;
  /** Event ISO time when Codex provided it; file mtime milliseconds
   * otherwise. Optional only for compatibility with older hosts. */
  sourceAt?: string | number;
  mtimeMs: number;
}

/** The newest usage event across ALL codex rollouts on disk — the boot
 * catch-up. Codex runs outside KeepDeck too, so its sessions dir can know
 * fresher limits than our persisted snapshot. Null when no rollout carries
 * usage (or codex was never used). */
export function latestCodexRollout(): Promise<LatestCodexRollout | null> {
  return invoke("usage_latest_codex_rollout");
}

/** The persisted usage snapshot (last-known account windows), or null on
 * first run. Schema belongs to `src/domain/usage` (the deck.json rule). */
export function loadUsageCache(): Promise<string | null> {
  return invoke("usage_cache_load");
}

/** Persist the usage snapshot (already serialized by the domain). */
export function saveUsageCache(json: string): Promise<void> {
  return invoke("usage_cache_save", { json });
}
