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
import { CARRIED_RECORD, type TailWatch } from "./sessionTail.ts";

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
  /** Monotonic within one reporter session generation; lets the host reject an
   * older async/file delivery after a newer snapshot. */
  sequence?: number;
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
 * Three payload keys are HOST-owned transport metadata, not agent schema:
 * `agent` (the dispatch key), `catchUp` (the event is a replay of an
 * existing session file at arm time), `sourceAt` (the event's ISO time or
 * unix milliseconds), and `sourceMtimeMs` (the file-mtime fallback when the
 * primary timestamp is malformed or clock-skewed). Normalizers may ignore
 * them. */
export type UsageNormalizer = (
  payload: unknown,
  at: number,
) => NormalizedUsage | null;

/** An account-limits document reader for a polled source: response body →
 * account state, or null when unreadable. */
export type LimitsNormalizer = (body: string, at: number) => AccountUsage | null;

/**
 * How the host's native tailer reads this agent's session store for the
 * numbers.
 *
 * This used to be the NAME of a dialect — "claude", "codex", "kimi-wire" —
 * and the reader held an arm per name: which lines carry counts, which
 * fields to trim them down to, how to add them up. Three agents' formats,
 * written into the side that was supposed to know none of them, where every
 * new file-fed CLI meant another arm and every CLI that changed its store
 * meant a change to the host.
 *
 * What replaces it is the same descriptor the status lane already uses. The
 * plugin says which records carry counts and what to keep of them; the
 * reader compares keys and copies fields. Nothing here names an agent.
 */
export interface UsageTail {
  /** Which records carry this agent's numbers, and what a total over them
   * is made of. Every watch here rides the usage lane. */
  readonly watches: readonly TailWatch[];

  /**
   * A directory of files that contribute to the SAME session as the store
   * being followed, or null when this agent keeps its session in one file.
   *
   * Claude writes a subagent's turns to `<transcript>/subagents/*.jsonl`,
   * and those rows are the session's cost as much as the root file's — but
   * the rule that turns one path into the other is claude's. The host used
   * to hold it, which meant every pane of every agent paid a directory read
   * per poll for a convention only one of them has.
   *
   * Given the store's path, answer with a directory. The host lists it each
   * poll rather than once, because the files appear as subagents start —
   * long after the tail was armed.
   */
  siblings?(store: string): string | null;

  /**
   * Stores worth reading cold at startup, newest first, when this agent's
   * store records the ACCOUNT's state.
   *
   * The boot catch-up: an agent that also runs outside KeepDeck can have
   * spent quota the deck never saw, so its own files can know fresher limits
   * than a persisted snapshot. The host reads these one at a time until a
   * normalizer makes an account claim, then stops — so answer with a bounded
   * list, and put the likeliest first.
   *
   * Omit unless the store really carries account state; a per-pane token
   * count is worth nothing before any pane exists.
   */
  sweep?(): Promise<readonly string[]>;
}

/** Native polled limit sources the host offers. */
export type UsageLimitsSource = "codex-app-server" | "kimi-usages";

/** Which half of the usage contract an agent can actually populate. Pane
 * telemetry (context/tokens/cost) and account limits (rolling windows) have
 * different UI homes and lifetimes; declaring either one must never imply the
 * other. */
export type UsageCapability = "paneTelemetry" | "accountLimits";

/** The usage half of an agent contribution.
 *
 * BUILT-IN (in-process) agents only for now: the external tier does not
 * carry usage across its RPC boundary — the store invokes `normalize`
 * synchronously per report, and a cross-realm proxy is necessarily async.
 * An external plugin's declaration is ignored with a host-log warning. */
export interface AgentUsage {
  /** @deprecated API 30+ plugins declare `usage.pane` / `usage.account` once
   * in the manifest. Retained only for legacy plugin execution. */
  capabilities?: readonly UsageCapability[];
  /** Normalize this agent's bridge usage payloads (statusLine reports,
   * tailed session-file events — whatever its reporters emit). */
  normalize: UsageNormalizer;
  /** Follow the session file named by this agent's bindings (the binding's
   * transcriptPath is the file), carrying the records this declares. */
  tail?: UsageTail;
  /** Account limits live behind a native source: the host fetches the named
   * source on a slow interval while one of this agent's panes is live; the
   * plugin reads the opaque body. */
  limits?: { poll: UsageLimitsSource; normalize: LimitsNormalizer };
}

/* ---- Authoring helpers ----------------------------------------------- *
 * The tolerant-reading idiom every normalizer shares: never throw, drop
 * what doesn't parse, keep the rest. */

/**
 * Everything one agent asked to have carried out of its store, in the order
 * the reader must try it.
 *
 * An agent declares its watches in TWO places, because they answer to two
 * different halves of its contribution: the records that carry its numbers
 * belong to the usage contract, the ones that carry its turn edges to the
 * status contract. Merging them is a THIRD decision, and it lives here
 * rather than at the call site because order is load-bearing twice over and
 * a rule that lives in a comment beside one caller is a rule the next caller
 * will not know about:
 *
 * - the FIRST watch to match a record carries it, so whichever list goes
 *   first can silently take a record the other one was written for;
 * - the usage watches' own order is the CATCH-UP order — what qualifies the
 *   numbers has to land before the numbers.
 *
 * Usage first, therefore, and the numbers keep their declared order. A
 * plugin that wants one record read two ways says so in its dialect's
 * `read`, where saying so is cheap.
 */
export function tailWatches(
  usage: UsageTail | undefined,
  status: { readonly watches: readonly TailWatch[] } | undefined,
): readonly TailWatch[] {
  return [...(usage?.watches ?? []), ...(status?.watches ?? [])];
}

/**
 * The fields a usage watch carried, out of one tailer report — or null when
 * this report is not a carried record at all.
 *
 * A normalizer's first move, and the reason it is here rather than repeated
 * in each plugin: the envelope around a carried record is the HOST's
 * transport, so a plugin that reached into it by hand would be reading a
 * shape it does not own, in as many copies as there are agents.
 *
 * What comes back is flat, and its keys are the ones the watch named — a
 * dotted `keep` arrives as a dotted KEY, not as rebuilt nesting, so
 * `message.usage.output_tokens` is read under exactly that name.
 */
export function carriedUsageRecord(
  payload: unknown,
): Record<string, unknown> | null {
  if (!isJsonRecord(payload)) return null;
  const event = payload.event;
  if (!isJsonRecord(event) || event.type !== CARRIED_RECORD) return null;
  return isJsonRecord(event.record) ? event.record : null;
}

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

/** A count as quota documents actually spell one — a number, or a numeric
 * STRING. Two providers send strings ("used":"7", "limit":"16000"): kimi's
 * usages endpoint and codex's `individualLimit`. `asFiniteNumber` rejects
 * those, which is exactly how codex's plan quota went unread. */
export function asCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * An absolute allowance — `{limit, used?, remaining?}` counts — as one
 * normalized window. The shape plans that meter credits share (kimi's
 * quota document, codex's business/Enterprise `individualLimit`), distinct
 * from the rolling-window shape that already arrives as a percentage.
 * `null` without a positive limit or any consumed/remaining count — a
 * percentage cannot be made from less. The reset instant and window length
 * stay the caller's: providers disagree on where and in what unit they live.
 */
export function allowanceWindow(
  value: unknown,
  opts: {
    resetsAt?: number | null;
    windowMinutes: number | null;
    scope?: string;
  },
): UsageWindow | null {
  if (!isJsonRecord(value)) return null;
  const limit = asCount(value.limit);
  if (limit === undefined || limit <= 0) return null;
  const used = asCount(value.used);
  const remaining = asCount(value.remaining);
  const usedPct =
    used !== undefined
      ? (used / limit) * 100
      : remaining !== undefined
        ? ((limit - remaining) / limit) * 100
        : undefined;
  if (usedPct === undefined) return null;
  return {
    usedPct: clampPercent(usedPct),
    resetsAt: opts.resetsAt ?? null,
    windowMinutes: opts.windowMinutes,
    ...(opts.scope ? { scope: opts.scope } : {}),
  };
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
