import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TailWatch } from "@keepdeck/plugin-api";

/**
 * Usage-report events: a pane's agent process reports rate-limit windows,
 * tokens and cost through the CLI bridge (statusLine script / reporter armed
 * at spawn); the Rust watcher passes the payload through verbatim and emits
 * this event. The constant mirrors `USAGE_REPORT_EVENT` in
 * src-tauri/src/bridge/wire.rs.
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

/** Follow a pane's session file; its records arrive as reports carrying
 * `token`. Idempotent per pane — a rebind replaces the old tail. */
export function watchSessionFile(
  paneId: string,
  path: string,
  token: string,
  /** The agent whose pane this is. Reports ride under it, and it is passed
   * from HERE because this is the side that knows which pane belongs to
   * which plugin — the backend has no way to tell and no business guessing. */
  agent: string,
  /** The pane's agent's own declaration of which records to carry out of its
   * store — both lanes of it, the numbers and the turn edges. The backend
   * applies these without reading them: it compares the keys it is given and
   * copies the ones it is named. An empty list carries NOTHING; there are no
   * readings of the host's own left behind them. */
  watches?: readonly TailWatch[],
  /** A directory of files contributing to the same session, when the agent's
   * dialect named one. Listed each poll: the files appear as the work that
   * writes them starts. */
  siblings?: string | null,
): Promise<void> {
  return invoke("usage_watch_session_file", {
    paneId,
    tail: {
      path,
      token,
      agent,
      watches: watches ?? [],
      siblings: siblings ?? null,
    },
  });
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

// Resolving a codex session's rollout used to live here, as a host command
// that knew the CLI's day-partitioned tree and its filename shape. It went
// home: the agent's own plugin already walked that tree for its history
// browser, and a store's layout is the agent's to know. What the host asks
// now is the dialect — see `SessionTailDialect.follow`.

/** One record a cold read carried, with the instant it claims for itself. */
export interface ColdRecord {
  event: unknown;
  /** The record's own ISO time or unix milliseconds when it carries one;
   * the file's mtime otherwise. */
  sourceAt?: string | number;
}

/** What one cold read found, and how old the file it came from is. */
export interface ColdRead {
  records: ColdRecord[];
  mtimeMs: number;
}

/** Read one store ONCE, from the beginning, with nobody following it — the
 * boot catch-up over a file this deck never watched being written.
 *
 * The answer is the same collapse a live arming produces, so one normalizer
 * reads a cold store and a live one without being told which. Null when the
 * file carries nothing the declaration asked for, which is how a caller
 * knows to try the next candidate. WHICH files are candidates is the agent's
 * to say — see `UsageTail.sweep`. */
export function readStoreCold(
  path: string,
  watches: readonly TailWatch[],
): Promise<ColdRead | null> {
  return invoke("usage_read_store_cold", { path, watches });
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
