import {
  periodCutoff,
  tokenTotal,
  type UsageEventV2,
  type UsageStatsPeriod,
} from "./history";

/**
 * Daily token buckets for the Overview chart — UTC days (the same buckets
 * the recap uses), zero-filled so the time axis never lies by omission: a
 * silent day is a visible gap, not a skipped bar.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface DailyUsageDay {
  dayStart: number;
  /** Tokens per agent that day; absent agents simply have no key. */
  byAgent: Record<string, number>;
}

export interface DailyUsage {
  /** Continuous UTC days covering the period (or, for "all", from the first
   * recorded day) through today. */
  days: DailyUsageDay[];
  /** Every agent present in the span, alphabetical — a FIXED entity order
   * for stable series colors, never ranked by volume. */
  agents: string[];
}

export function dailyUsage(
  events: readonly UsageEventV2[],
  period: UsageStatsPeriod,
  now: number,
): DailyUsage {
  const cutoff = periodCutoff(period, now);
  const buckets = new Map<number, Record<string, number>>();
  const agents = new Set<string>();
  let firstDay = Infinity;
  for (const event of events) {
    if (event.occurredAt < cutoff || event.occurredAt > now) continue;
    const dayStart = Math.floor(event.occurredAt / DAY_MS) * DAY_MS;
    firstDay = Math.min(firstDay, dayStart);
    agents.add(event.agent);
    const bucket = buckets.get(dayStart) ?? {};
    bucket[event.agent] = (bucket[event.agent] ?? 0) + tokenTotal(event.tokens);
    buckets.set(dayStart, bucket);
  }
  if (buckets.size === 0) return { days: [], agents: [] };

  const start =
    period === "all" ? firstDay : Math.floor(cutoff / DAY_MS) * DAY_MS;
  const end = Math.floor(now / DAY_MS) * DAY_MS;
  const days: DailyUsageDay[] = [];
  for (let day = start; day <= end; day += DAY_MS) {
    days.push({ dayStart: day, byAgent: buckets.get(day) ?? {} });
  }
  return { days, agents: [...agents].sort() };
}
