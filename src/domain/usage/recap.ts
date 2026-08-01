import {
  periodCutoff,
  queryUsageStats,
  tokenTotal,
  type UsageEventV2,
  type UsageStats,
  type UsageStatsPeriod,
} from "./history";
import { DAY_MS, utcDayStart } from "./time";

/**
 * The Highlights line — the period's numbers with their context: how the
 * spend moved against the preceding equal-length period, which model ate
 * the most, which day was heaviest. Pure and time-injected like every
 * stats query.
 */

export interface UsageRecap {
  /** Whole-percent change of period tokens vs the preceding equal-length
   * period. Null when there is no predecessor to compare against: the "all"
   * period, or a prior window with no recorded usage. Tokens only — cost
   * coverage varies by session, so a cost delta would routinely lie. */
  tokensDeltaPct: number | null;
  topModel: { agent: string; model: string; totalTokens: number } | null;
  busiestDay: { dayStart: number; totalTokens: number } | null;
}

/** `current` is the caller's already-aggregated period stats — the recap
 * DESCRIBES the numbers rendered beside it, so re-aggregating here (at a
 * potentially different clock) would let "+12%" talk about a total the
 * user is not looking at, and would triple the full-ledger scans. */
export function usageRecap(
  events: readonly UsageEventV2[],
  period: UsageStatsPeriod,
  now: number,
  current: UsageStats,
): UsageRecap {
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
  // Both period bounds are inclusive, so the prior window ends one instant
  // BEFORE the current one opens — a boundary event must not count twice.
  const prior = queryUsageStats(events, period, now - period * DAY_MS - 1);
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
    const dayStart = utcDayStart(event.occurredAt);
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
