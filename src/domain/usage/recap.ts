import { formatTokens, formatUtcDay, PERIOD_LABELS } from "./format";
import { tokenTotal, type UsageEventV2 } from "./history/event";
import {
  periodCutoff,
  queryUsageStats,
  type UsageStats,
  type UsageStatsPeriod,
} from "./history/query";
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

/** THE Highlights sentence — which highlights appear, their order, the
 * separator and the sign convention are a product rule, phrased here like
 * every sibling caption (costCoverage, windowResetCaption, the achievement
 * captions) so a digest notification or a copy-summary command reuses the
 * exact wording instead of re-deriving it in a component. Empty string when
 * the period offers no highlight worth reading. */
export function recapCaption(
  recap: UsageRecap,
  period: UsageStatsPeriod,
): string {
  const parts: string[] = [];
  if (recap.tokensDeltaPct !== null) {
    const sign = recap.tokensDeltaPct >= 0 ? "+" : "";
    parts.push(
      `${sign}${recap.tokensDeltaPct}% vs prior ${PERIOD_LABELS[period]}`,
    );
  }
  if (recap.topModel) {
    parts.push(
      `top model ${recap.topModel.model} (${formatTokens(recap.topModel.totalTokens)})`,
    );
  }
  if (recap.busiestDay) {
    parts.push(
      `busiest day ${formatUtcDay(recap.busiestDay.dayStart)} (${formatTokens(
        recap.busiestDay.totalTokens,
      )})`,
    );
  }
  return parts.join(" · ");
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

/** Heaviest UTC day of the period, by IN-WINDOW totals. UTC buckets keep
 * the answer deterministic everywhere; the display labels the day in UTC
 * to match. Deliberately the same accounting as every number beside it —
 * the cards and the delta count the window, so the crown must too. (A
 * "full days only" variant was tried and verified worse: it crowned a
 * 5-token blip over a 900k session sitting in the leading partial day,
 * making the caption contradict its own top-model line, and for the 24h
 * period it discarded almost the whole window.) */
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
