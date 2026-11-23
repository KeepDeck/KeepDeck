import {
  allowanceWindow,
  asCount,
  asFiniteNumber,
  asNonEmptyString,
  carriedRecord,
  isJsonRecord,
  parseInstant,
  parseJsonRecord,
  reportedLimits,
  type CallTokens,
  type CarriedRecord,
  type LimitsNormalizer,
  type TailWatch,
  type UsageCall,
  type UsageNormalizer,
  type UsageWindow,
} from "@keepdeck/plugin-api";
import type { KimiModelTable } from "./models";

/**
 * Kimi usage — two normalizers because kimi splits its data in two:
 *
 * - The session's wire.jsonl, tailed by the host (`{agent:"kimi", event}`),
 *   holds a PER-REQUEST `usage.record` — one call each, its input
 *   components THAT turn's context occupancy, and the alias of the model it
 *   ran on. The window that occupancy is measured against is the model's,
 *   from kimi's config (./models.ts). Before kimi 2.6.0 the wire also held a
 *   trimmed `llm.request` naming the bare model id a request went to; calls
 *   are still booked under it where it is written. Each subagent writes a
 *   wire of its own beside the main one (`agents/<id>/wire.jsonl`). NOTE:
 *   this on-disk shape is kimi-code's less-documented internal log (not the
 *   documented wire-mode JSON-RPC surface) — kimi has changed it before.
 * - Account rate-limit windows exist NOWHERE on disk — kimi's own /usage
 *   queries the network. The host polls the usages endpoint while a kimi
 *   pane is live; [`normalizeKimiUsages`] reads the response document.
 */

/**
 * Where a kimi session keeps its agents' wires: `<session>/agents`, the main
 * agent's beside each subagent's — every one of them the session's spend.
 */
export function kimiAgentsDirectory(store: string): string {
  return store.replace(/\/agents\/[^/]+\/[^/]+$/, "/agents");
}

/**
 * Which wire records carry the numbers.
 *
 * `usage.record` rides TWO lanes: the pane's occupancy, with the model whose
 * window it is measured against (`usage`), and a call (`calls`).
 * `llm.request`, written by kimi before 2.6.0 only, names the bare model id
 * the next calls ran on (`calls`, as their context). Its `maxTokens` was the
 * request's output cap, never the window, so it feeds no gauge. Each lane's
 * watch keeps only what its reading needs: the full request carries the
 * prompt, and naming a few scalars is what keeps a conversation inside the
 * store.
 *
 * Kimi writes a call ONCE and gives it no id: its place in the wire is its
 * id. A fork copies the wire whole, places and original times alike — the
 * usage history drops those copies by their time, as older than the fork.
 */
export const kimiUsageWatches: readonly TailWatch[] = [
  {
    match: [{ key: "type", equals: "usage.record" }],
    keep: ["type", "model", "usage", "usageScope"],
    lane: "usage",
  },
  {
    match: [{ key: "type", equals: "llm.request" }],
    // `model` is the bare id the request went to ("k3-256k"); `modelAlias`
    // is only the name kimi shows for it.
    keep: ["model"],
    lane: "calls",
    context: true,
  },
  {
    match: [{ key: "type", equals: "usage.record" }],
    keep: ["type", "model", "usage"],
    lane: "calls",
  },
];

/** A count, or 0 for anything that is not one. */
function count(value: unknown): number {
  const counted = asFiniteNumber(value);
  return counted !== undefined && counted > 0 ? counted : 0;
}

/**
 * A kimi token bag in the canonical classes: kimi already counts its fresh
 * input (`inputOther`) apart from the cache read and the cache write, and
 * states no reasoning of its own.
 */
function kimiTokens(bag: Record<string, unknown>): CallTokens {
  return {
    input: count(bag.inputOther),
    cacheRead: count(bag.inputCacheRead),
    cacheWrite: count(bag.inputCacheCreation),
    output: count(bag.output),
  };
}

/** One `usage.record` as its call — none without its place, its time or a
 * model to book it under. The model is the request's bare id; a record
 * before any request names only kimi's alias for it. */
function kimiCall(carried: CarriedRecord): UsageCall | null {
  const usage = carried.record.usage;
  const model =
    (carried.context ? asNonEmptyString(carried.context.model) : undefined) ??
    asNonEmptyString(carried.record.model);
  if (!carried.ref || carried.at === undefined || !isJsonRecord(usage) || !model) return null;
  return {
    id: `${carried.ref.file}#${carried.ref.offset}`,
    at: carried.at,
    provider: "kimi-code",
    model,
    tokens: kimiTokens(usage),
  };
}

/** The wire normalizer of one registration, reading each record's window
 * from that registration's model table. */
export function kimiWireNormalizer(models: Pick<KimiModelTable, "windowOf">): UsageNormalizer {
  return (payload, at) => normalizeKimiWire(payload, at, models);
}

function normalizeKimiWire(
  payload: Parameters<UsageNormalizer>[0],
  at: number,
  models: Pick<KimiModelTable, "windowOf">,
): ReturnType<UsageNormalizer> {
  const carried = carriedRecord(payload);
  if (!carried) return null;
  const event = carried.record;

  if (carried.lane === "calls") {
    if (event.type !== "usage.record") return null;
    const call = kimiCall(carried);
    return { account: null, pane: null, calls: call ? [call] : [] };
  }

  if (event.type !== "usage.record") return null;

  const usage = isJsonRecord(event.usage) ? event.usage : undefined;
  const input = usage ? asFiniteNumber(usage.inputOther) : undefined;
  const cacheRead = usage ? asFiniteNumber(usage.inputCacheRead) : undefined;
  const cacheWrite = usage ? asFiniteNumber(usage.inputCacheCreation) : undefined;

  // A record kimi scopes to the SESSION rather than to a turn is not a turn:
  // it is a request the session made on its own behalf, and the one that
  // exists is compaction — the wire brackets it between
  // `full_compaction.begin` and `full_compaction.complete`.
  //
  // Its COST is real and counts — it rides the calls lane like any request.
  // Its input is not the context: it is the context that was just thrown
  // away. Read as a turn, it puts the pre-compaction size on the gauge at
  // the exact moment the context emptied — measured on three sessions, 305k
  // shown against a real 39k, 242k against 35k, and 213k against 2k — and it
  // stands there until the next real turn. So it is no reading of "what is
  // in the window".
  const perTurn = event.usageScope !== "session";
  // The request's full input (fresh + cache read + cache write) is what
  // occupies the context; the window is the model's, from kimi's config.
  const occupied =
    perTurn &&
    (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined)
      ? (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined;
  if (occupied === undefined) return { account: null, pane: null };
  const model = asNonEmptyString(event.model);
  const windowTokens = model === undefined ? undefined : models.windowOf(model);

  return {
    account: null,
    pane: {
      agent: "kimi",
      context: { usedTokens: occupied, ...(windowTokens !== undefined && { windowTokens }) },
      reportedAt: at,
    },
  };
}

/** One window from {limit, used?, remaining?, resetTime?} counts. The
 * count-math lives in plugin-api's [`allowanceWindow`] (codex's plan quota
 * shares the shape, strings and all); kimi's part is only where its reset
 * instant lives — an ISO string on the same record. */
function quotaWindow(
  value: unknown,
  windowMinutes: number | null,
  scope?: string,
): UsageWindow | null {
  if (!isJsonRecord(value)) return null;
  return allowanceWindow(value, {
    resetsAt: parseInstant(value.resetTime),
    windowMinutes,
    ...(scope ? { scope } : {}),
  });
}

function windowMinutesOf(window: unknown): number | null {
  if (!isJsonRecord(window)) return null;
  const duration = asCount(window.duration);
  if (duration === undefined) return null;
  switch (window.timeUnit) {
    case "TIME_UNIT_SECOND":
      return Math.round(duration / 60);
    case "TIME_UNIT_MINUTE":
      return duration;
    case "TIME_UNIT_HOUR":
      return duration * 60;
    case "TIME_UNIT_DAY":
      return duration * 1440;
    default:
      return null;
  }
}

/**
 * The usages document → account windows: `limits[]` are the rolling windows
 * (duration-labeled, e.g. 300 min = 5h); the top-level `usage{}` is the
 * plan's primary window — the document carries no duration for it, but
 * kimi's own console titles it "Weekly usage" and its reset cadence agrees,
 * so it is stamped as 7 days here; `totalQuota{}` is the overall plan
 * quota, scoped so it shows in the panel but never crowds the chip.
 */
const PLAN_WINDOW_MINUTES = 7 * 1440;
export const normalizeKimiUsages: LimitsNormalizer = (body, at) => {
  const raw = parseJsonRecord(body);
  if (!raw) return null;

  const windows: UsageWindow[] = [];
  if (Array.isArray(raw.limits)) {
    for (const entry of raw.limits) {
      if (!isJsonRecord(entry)) continue;
      // The row's own name, when it has one: kimi labels its limit windows,
      // and dropping the label left the panel showing durations with nothing
      // saying what they limit.
      const parsed = quotaWindow(
        entry.detail,
        windowMinutesOf(entry.window),
        asNonEmptyString(entry.name),
      );
      if (parsed) windows.push(parsed);
    }
  }
  const plan = quotaWindow(raw.usage, PLAN_WINDOW_MINUTES);
  if (plan) windows.push(plan);
  const quota = quotaWindow(raw.totalQuota, null, "quota");
  if (quota) windows.push(quota);

  if (windows.length === 0) return null;
  return reportedLimits(windows, at);
};
