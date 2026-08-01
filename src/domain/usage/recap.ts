import {
  periodCutoff,
  queryUsageStats,
  tokenTotal,
  type UsageEventV2,
  type UsageStats,
  type UsageStatsPeriod,
} from "./history";

/**
 * The Highlights line — the period's numbers with their context: how the
 * spend moved against the preceding equal-length period, which model ate
 * the most, which day was heaviest. Pure and time-injected like every
 * stats query.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface UsageRecap {
  /** Whole-percent change of period tokens vs the preceding equal-length
   * period. Null when there is no predecessor to compare against: the "all"
   * period, or a prior window with no recorded usage. Tokens only — cost
   * coverage varies by session, so a cost delta would routinely lie. */
  tokensDeltaPct: number | null;
  topModel: { agent: string; model: string; totalTokens: number } | null;
  busiestDay: { dayStart: number; totalTokens: number } | null;
}

export function usageRecap(
  events: readonly UsageEventV2[],
  period: UsageStatsPeriod,
  now: number,
): UsageRecap {
  const current = queryUsageStats(events, period, now);
  return {
    tokensDeltaPct: tokensDeltaPct(events, period, now, current),
    topModel: topModel(current),
    busiestDay: busiestDay(events, period, now),
  };
}

function tokensDeltaPct(
  events: readonly UsageEventV2[],
  period: UsageStatsPeriod,
  now: number,
  current: UsageStats,
): number | null {
  if (period === "all") return null;
  const prior = queryUsageStats(events, period, now - period * DAY_MS);
  if (prior.totals.totalTokens <= 0) return null;
  return Math.round(
    ((current.totals.totalTokens - prior.totals.totalTokens) /
      prior.totals.totalTokens) *
      100,
  );
}

/** The model that consumed the most TOKENS — `byModel` ranks by cost first,
 * which would crown a costed model over a bigger uncosted one. */
function topModel(current: UsageStats): UsageRecap["topModel"] {
  let top: UsageRecap["topModel"] = null;
  for (const row of current.byModel) {
    if (top === null || row.totalTokens > top.totalTokens) {
      top = {
        agent: row.agent,
        model: row.model ?? "Unknown model",
        totalTokens: row.totalTokens,
      };
    }
  }
  return top;
}

/** Heaviest UTC day of the period. UTC buckets keep the answer deterministic
 * everywhere; the display labels the day in UTC to match. */
function busiestDay(
  events: readonly UsageEventV2[],
  period: UsageStatsPeriod,
  now: number,
): UsageRecap["busiestDay"] {
  const cutoff = periodCutoff(period, now);
  const days = new Map<number, number>();
  for (const event of events) {
    if (event.occurredAt < cutoff || event.occurredAt > now) continue;
    const dayStart = Math.floor(event.occurredAt / DAY_MS) * DAY_MS;
    days.set(dayStart, (days.get(dayStart) ?? 0) + tokenTotal(event.tokens));
  }
  let top: UsageRecap["busiestDay"] = null;
  for (const [dayStart, totalTokens] of days) {
    if (top === null || totalTokens > top.totalTokens) {
      top = { dayStart, totalTokens };
    }
  }
  return top;
}
