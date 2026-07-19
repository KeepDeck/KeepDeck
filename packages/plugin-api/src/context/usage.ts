/**
 * Usage contract — how a CLI plugin teaches KeepDeck to read its agent's
 * usage: rate-limit windows, token counts, context occupancy. The plugin
 * owns its CLI's payload SCHEMA (the normalizers below); the host owns the
 * transport (bridge envelopes, the native session-file tailer, the native
 * limit pollers) and the store/UI.
 *
 * Everything here is plain data in and plain data out, so a normalizer runs
 * identically in-process or across the external tier's RPC boundary.
 */

/** One provider rate-limit window, normalized across CLIs. Labels derive
 * from `windowMinutes` — NEVER from field position: codex plans disagree
 * about which window is primary. */
export interface UsageWindow {
  /** 0–100, share of the window consumed. */
  usedPct: number;
  /** Absolute reset instant, unix MILLISECONDS (null = the CLI didn't say).
   * Countdowns are computed client-side from this — an idle pane stops
   * reporting, the clock must keep ticking. */
  resetsAt: number | null;
  /** Window length in minutes (300 = 5h, 10080 = weekly, 43200 = monthly). */
  windowMinutes: number | null;
  /** Model- or bucket-scoped windows carry their scope (e.g. a per-model
   * weekly, a plan quota); account-wide windows leave it undefined. */
  scope?: string;
}

/** The account-level state of one provider — a claim, or the reasoned
 * absence of one. A union so a chip can't render limits and "unavailable"
 * at once. */
export type AccountUsage =
  | {
      kind: "reported";
      windows: UsageWindow[];
      reportedAt: number;
      /** The pane whose report won freshest-wins — diagnostics only; the
       * host fills it. */
      sourcePaneId: string;
    }
  | {
      kind: "unavailable";
      /** Why there are no windows: API-key billing has no plan windows. */
      reason: "api-key";
      reportedAt: number;
    };

/** Token counts as a CLI reports them; every field optional — providers
 * disagree on what they expose. */
export interface TokenCounts {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
}

/** One pane's live session usage. The context bag speaks whichever terms
 * the CLI does — a ready-made percentage, or tokens against a window size
 * that may arrive in a SEPARATE report; the host merges bags field-wise. */
export interface PaneUsage {
  agent: string;
  sessionId?: string;
  /** Human model name ("Opus") when the CLI offers one; else the raw id. */
  model?: string;
  context?: {
    usedPct?: number;
    usedTokens?: number;
    windowTokens?: number;
  };
  costUsd?: number;
  totalTokens?: TokenCounts;
  lastTurnTokens?: TokenCounts;
  reportedAt: number;
}

/** What one bridge report normalizes into. `account: null` means the report
 * made no account-level claim (too early to tell — distinct from
 * "unavailable", which is a positive claim of absence). */
export interface NormalizedUsage {
  account: AccountUsage | null;
  pane: PaneUsage | null;
}

/** A per-agent normalizer: raw bridge payload → normalized usage, or null
 * when the payload is not recognizable. Pure; time is injected.
 *
 * Two payload keys are HOST-owned transport metadata, not agent schema:
 * `agent` (the dispatch key) and `catchUp` (the event is a replay of an
 * existing session file at arm time — the host's store lets such replays
 * fill gaps but never outrank live data). Normalizers may ignore both. */
export type UsageNormalizer = (
  payload: unknown,
  at: number,
) => NormalizedUsage | null;

/** An account-limits document reader for a polled source: response body →
 * account state, or null when unreadable. */
export type LimitsNormalizer = (body: string, at: number) => AccountUsage | null;

/** Session-file dialects the host's native tailer speaks. */
export type UsageTailFormat = "codex" | "kimi-wire";

/** Native polled limit sources the host offers. */
export type UsageLimitsSource = "codex-app-server" | "kimi-usages";

/** The usage half of an agent contribution.
 *
 * BUILT-IN (in-process) agents only for now: the external tier does not
 * carry usage across its RPC boundary — the store invokes `normalize`
 * synchronously per report, and a cross-realm proxy is necessarily async.
 * An external plugin's declaration is ignored with a host-log warning. */
export interface AgentUsage {
  /** Normalize this agent's bridge usage payloads (statusLine reports,
   * tailed session-file events — whatever its reporters emit). */
  normalize: UsageNormalizer;
  /** Follow the session file named by this agent's bindings with the given
   * dialect (the binding's transcriptPath is the file). */
  tail?: UsageTailFormat;
  /** Account limits live behind a native source: the host fetches the named
   * source on a slow interval while one of this agent's panes is live; the
   * plugin reads the opaque body. */
  limits?: { poll: UsageLimitsSource; normalize: LimitsNormalizer };
}

/* ---- Authoring helpers ----------------------------------------------- *
 * The tolerant-reading idiom every normalizer shares: never throw, drop
 * what doesn't parse, keep the rest. */

/** Whether `value` is a plain JSON object: not null, not an array. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number or undefined — never NaN/Infinity into the store. */
export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A non-empty string or undefined. */
export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Clamp a percentage into 0–100. */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Collect present token fields; undefined when none are — an empty counts
 * object would read as "reported zero of everything". */
export function collectTokenCounts(
  fields: Record<keyof TokenCounts, unknown>,
): TokenCounts | undefined {
  const counts: TokenCounts = {};
  for (const [key, raw] of Object.entries(fields)) {
    const value = asFiniteNumber(raw);
    if (value !== undefined) counts[key as keyof TokenCounts] = value;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}
