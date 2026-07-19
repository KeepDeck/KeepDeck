import {
  asFiniteNumber,
  asNonEmptyString,
  clampPercent,
  collectTokenCounts,
  isJsonRecord,
  type LimitsNormalizer,
  type UsageNormalizer,
  type UsageWindow,
} from "@keepdeck/plugin-api";

/**
 * Kimi usage — two normalizers because kimi splits its data in two:
 *
 * - Per-pane tokens/context live in the session's wire.jsonl, tailed by the
 *   host (`{agent:"kimi", event}`): a `usage.record` per LLM request (token
 *   counts; their sum IS the context occupancy) and a trimmed `llm.request`
 *   (model + maxTokens = the window size). The store merges the two.
 * - Account rate-limit windows exist NOWHERE on disk — kimi's own /usage
 *   queries the network. The host polls the usages endpoint while a kimi
 *   pane is live; [`normalizeKimiUsages`] reads the response document.
 */

export const normalizeKimiWire: UsageNormalizer = (payload, at) => {
  if (!isJsonRecord(payload)) return null;
  const event = payload.event;
  if (!isJsonRecord(event)) return null;

  if (event.type === "llm.request") {
    const model = asNonEmptyString(event.model);
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
  const lastTurnTokens = usage
    ? collectTokenCounts({
        input: usage.inputOther,
        output: usage.output,
        cacheRead: usage.inputCacheRead,
        cacheWrite: usage.inputCacheCreation,
        reasoning: undefined,
        total: undefined,
      })
    : undefined;
  // The request's full input (fresh + cache read + cache write) is what
  // occupies the context; the window size arrives via llm.request.
  const occupied =
    input !== undefined || cacheRead !== undefined || cacheWrite !== undefined
      ? (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined;

  return {
    account: null,
    pane: {
      agent: "kimi",
      ...(model ? { model } : {}),
      ...(lastTurnTokens ? { lastTurnTokens } : {}),
      ...(occupied !== undefined ? { context: { usedTokens: occupied } } : {}),
      reportedAt: at,
    },
  };
};

/** Quota numbers in the usages document are JSON STRINGS ("used":"7") —
 * read both spellings of a count. */
function asCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** One window from {limit, used?, remaining?, resetTime?} counts. */
function quotaWindow(
  value: unknown,
  windowMinutes: number | null,
  scope?: string,
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
  const resetsAt =
    typeof value.resetTime === "string" ? Date.parse(value.resetTime) : NaN;
  return {
    usedPct: clampPercent(usedPct),
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    windowMinutes,
    ...(scope ? { scope } : {}),
  };
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
      const parsed = quotaWindow(entry.detail, windowMinutesOf(entry.window));
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
