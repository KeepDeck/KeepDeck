import {
  allowanceWindow,
  asCount,
  asFiniteNumber,
  asNonEmptyString,
  carriedUsageRecord,
  collectTokenCounts,
  isJsonRecord,
  type LimitsNormalizer,
  type TailWatch,
  type TokenCounts,
  type UsageNormalizer,
  type UsageWindow,
} from "@keepdeck/plugin-api";

/**
 * Kimi usage — two normalizers because kimi splits its data in two:
 *
 * - Per-pane tokens/context live in the session's wire.jsonl, tailed by the
 *   host (`{agent:"kimi", event}`): a PER-REQUEST `usage.record` (its input
 *   components sum to THAT turn's context occupancy — occupancy is the latest
 *   record, never a sum across records) and a trimmed `llm.request` (model +
 *   maxTokens = the window size). The store merges the two. Kimi writes no
 *   session token total, so the host tailer folds the per-request records into
 *   a cumulative and stamps it as `sessionTotals` → `totalTokens` below. NOTE:
 *   this on-disk `usage.record` shape is kimi-code's less-documented internal
 *   log (not the documented wire-mode JSON-RPC surface) — kimi has changed it
 *   once already.
 * - Account rate-limit windows exist NOWHERE on disk — kimi's own /usage
 *   queries the network. The host polls the usages endpoint while a kimi
 *   pane is live; [`normalizeKimiUsages`] reads the response document.
 */

/**
 * Which wire records carry the numbers, and what a session total is made of.
 *
 * `llm.request` is declared FIRST because declaration order is the catch-up
 * order — the window size has to land before the counts measured against it.
 * It is also the record that must be trimmed hardest: the full event carries
 * the prompt, and naming three scalars is what keeps a conversation inside
 * the store rather than a rule anyone has to remember.
 *
 * The sum has no `dedupBy`: kimi writes one record per request and repeats
 * nothing, so every row is its own event and simply adds. Buckets stay
 * separate — `inputCacheRead` is the re-read context prefix, and folding it
 * into fresh input would report a session as having spent what it re-sent.
 */
export const kimiUsageWatches: readonly TailWatch[] = [
  {
    match: [{ key: "type", equals: "llm.request" }],
    // `modelAlias` is the name kimi SHOWS ("kimi-code/k3-256k") and the one
    // `usage.record` reports; `model` is the bare id. Both travel, so one
    // pane cannot label the same model two ways depending on which record
    // arrived last.
    keep: ["type", "model", "modelAlias", "maxTokens"],
    lane: "usage",
  },
  {
    match: [{ key: "type", equals: "usage.record" }],
    keep: ["type", "model", "usage", "usageScope"],
    lane: "usage",
    sum: {
      buckets: {
        inputOther: "usage.inputOther",
        output: "usage.output",
        inputCacheRead: "usage.inputCacheRead",
        inputCacheCreation: "usage.inputCacheCreation",
      },
      stampAs: "sessionTotals",
    },
  },
];

/** A kimi token bag ({inputOther, output, inputCacheRead, inputCacheCreation})
 * → normalized counts. The per-request `usage` and the host tailer's cumulative
 * `sessionTotals` share this exact shape (the latter is the former summed), so
 * both map through here — a rename touches ONE place. */
function tokens(bag: Record<string, unknown> | undefined): TokenCounts | undefined {
  if (!bag) return undefined;
  return collectTokenCounts({
    input: bag.inputOther,
    output: bag.output,
    cacheRead: bag.inputCacheRead,
    cacheWrite: bag.inputCacheCreation,
    reasoning: undefined,
    total: undefined,
  });
}

export const normalizeKimiWire: UsageNormalizer = (payload, at) => {
  const event = carriedUsageRecord(payload);
  if (!event) return null;

  if (event.type === "llm.request") {
    // `model` is the bare id ("k3-256k"); `modelAlias` is the name kimi
    // shows for it ("kimi-code/k3-256k"), and it is what `usage.record`
    // reports — so preferring the alias keeps one pane from labelling the
    // same model two ways depending on which event arrived last.
    const model =
      asNonEmptyString(event.modelAlias) ?? asNonEmptyString(event.model);
    const windowTokens = asFiniteNumber(event.maxTokens);
    if (!model && windowTokens === undefined) {
      return { account: null, pane: null };
    }
    return {
      account: null,
      pane: {
        agent: "kimi",
        ...(model ? { model } : {}),
        ...(windowTokens !== undefined ? { context: { windowTokens } } : {}),
        reportedAt: at,
      },
    };
  }
  if (event.type !== "usage.record") return null;

  const usage = isJsonRecord(event.usage) ? event.usage : undefined;
  const model = asNonEmptyString(event.model);
  const input = usage ? asFiniteNumber(usage.inputOther) : undefined;
  const cacheRead = usage ? asFiniteNumber(usage.inputCacheRead) : undefined;
  const cacheWrite = usage ? asFiniteNumber(usage.inputCacheCreation) : undefined;

  // A record kimi scopes to the SESSION rather than to a turn is not a turn:
  // it is a request the session made on its own behalf, and the one that
  // exists is compaction — the wire brackets it between
  // `full_compaction.begin` and `full_compaction.complete`.
  //
  // Its COST is real and counts, which is why the fold takes every record.
  // Its input is not the context: it is the context that was just thrown
  // away. Read as a turn, it puts the pre-compaction size on the gauge at
  // the exact moment the context emptied — measured on three sessions, 305k
  // shown against a real 39k, 242k against 35k, and 213k against 2k — and it
  // stands there until the next real turn. So the numbers ride, and the
  // reading of them as "this turn" and "what is in the window" does not.
  const perTurn = event.usageScope !== "session";
  const lastTurnTokens = perTurn ? tokens(usage) : undefined;
  // The request's full input (fresh + cache read + cache write) is what
  // occupies the context; the window size arrives via llm.request.
  const occupied =
    perTurn &&
    (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined)
      ? (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined;

  // The host tailer stamps the running SESSION cumulative its dialect asked
  // for onto each record — kimi itself carries no per-session total. Buckets
  // are summed separately (inputCacheRead, the re-read prefix, stays out of
  // fresh input).
  const totals = isJsonRecord(event.sessionTotals) ? event.sessionTotals : undefined;
  const totalTokens = tokens(totals);

  return {
    account: null,
    pane: {
      agent: "kimi",
      ...(model ? { model } : {}),
      ...(lastTurnTokens ? { lastTurnTokens } : {}),
      ...(totalTokens ? { totalTokens } : {}),
      ...(occupied !== undefined ? { context: { usedTokens: occupied } } : {}),
      reportedAt: at,
    },
  };
};

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
  const resetsAt =
    typeof value.resetTime === "string" ? Date.parse(value.resetTime) : NaN;
  return allowanceWindow(value, {
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
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
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isJsonRecord(raw)) return null;

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
  return { kind: "reported", windows, reportedAt: at, sourcePaneId: "" };
};
