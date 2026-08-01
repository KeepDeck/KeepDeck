import {
  periodCutoff,
  tokenTotal,
  type UsageEventV2,
  type UsageStatsPeriod,
} from "./history";
import { DAY_MS, HOUR_MS } from "./time";

/**
 * Token buckets over time for the Overview chart, zero-filled so the time
 * axis never lies by omission: a silent bucket is a visible gap, not a
 * skipped bar. Day-long periods bucket by UTC day (the same buckets the
 * recap uses); the 24h period buckets by HOUR — two day-bars with a chasm
 * between them read as a broken chart.
 */

export interface TimelineBucket {
  start: number;
  /** Tokens per agent in this bucket; absent agents simply have no key. */
  byAgent: Record<string, number>;
}

export interface UsageTimeline {
  /** Bucket width: an hour for the 24h period, a UTC day otherwise. */
  bucketMs: number;
  /** Continuous buckets covering the period (or, for "all", from the first
   * recorded bucket) through now. */
  buckets: TimelineBucket[];
  /** Every agent present in the span, alphabetical — a FIXED entity order
   * for stable series colors, never ranked by volume. */
  agents: string[];
}

/** Every agent the ledger has EVER seen, sorted — the stable roster that
 * keys chart colors. Period-filtered agent lists must never key colors:
 * that is how a period switch repaints a provider. */
export function usageAgents(events: readonly UsageEventV2[]): string[] {
  const agents = new Set<string>();
  for (const event of events) agents.add(event.agent);
  return [...agents].sort();
}

export function usageTimeline(
  events: readonly UsageEventV2[],
  period: UsageStatsPeriod,
  now: number,
): UsageTimeline {
  const bucketMs = period === 1 ? HOUR_MS : DAY_MS;
  const cutoff = periodCutoff(period, now);
  const totals = new Map<number, Record<string, number>>();
  const agents = new Set<string>();
  let first = Infinity;
  for (const event of events) {
    if (event.occurredAt < cutoff || event.occurredAt > now) continue;
    const start = Math.floor(event.occurredAt / bucketMs) * bucketMs;
    first = Math.min(first, start);
    agents.add(event.agent);
    const bucket = totals.get(start) ?? {};
    bucket[event.agent] = (bucket[event.agent] ?? 0) + tokenTotal(event.tokens);
    totals.set(start, bucket);
  }
  if (totals.size === 0) return { bucketMs, buckets: [], agents: [] };

  const start =
    period === "all" ? first : Math.floor(cutoff / bucketMs) * bucketMs;
  const end = Math.floor(now / bucketMs) * bucketMs;
  const buckets: TimelineBucket[] = [];
  for (let at = start; at <= end; at += bucketMs) {
    buckets.push({ start: at, byAgent: totals.get(at) ?? {} });
  }
  return { bucketMs, buckets, agents: [...agents].sort() };
}
