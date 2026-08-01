import { tokenTotal, type UsageEventV2 } from "./history/event";
import { periodCutoff, type UsageStatsPeriod } from "./history/query";
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
  /** What one bucket IS — the discriminant consumers switch on for labels
   * and titles, so a future third width extends a union instead of
   * silently falling through a `bucketMs !== HOUR_MS` comparison. */
  granularity: "hour" | "day";
  /** Bucket width: an hour for the 24h period, a UTC day otherwise. */
  bucketMs: number;
  /** Continuous buckets covering the period (or, for "all", from the first
   * recorded bucket) through now. */
  buckets: TimelineBucket[];
  /** Every agent present in the EMITTED buckets, alphabetical — a FIXED
   * entity order, never ranked by volume. (Colors key on the full-ledger
   * roster from [`usageAgents`], not on this period-scoped list.) */
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
  const granularity = period === 1 ? ("hour" as const) : ("day" as const);
  const bucketMs = granularity === "hour" ? HOUR_MS : DAY_MS;
  const cutoff = periodCutoff(period, now);
  const totals = new Map<number, Record<string, number>>();
  let first = Infinity;
  for (const event of events) {
    if (event.occurredAt < cutoff || event.occurredAt > now) continue;
    const start = Math.floor(event.occurredAt / bucketMs) * bucketMs;
    first = Math.min(first, start);
    // Null-prototype buckets: agent ids are plugin-declared strings, and a
    // plain object literal would resolve "__proto__" through the prototype
    // chain — silently losing that agent's tokens.
    const bucket =
      totals.get(start) ?? (Object.create(null) as Record<string, number>);
    bucket[event.agent] = (bucket[event.agent] ?? 0) + tokenTotal(event.tokens);
    totals.set(start, bucket);
  }
  if (totals.size === 0) return { granularity, bucketMs, buckets: [], agents: [] };

  // The axis opens at the first bucket ENTIRELY inside the window: a bar
  // labeled "Jul 15" must cover all of Jul 15, not the slice a rolling
  // cutoff happens to leave — a partial leading bar reads as "that day was
  // quiet" when the day simply is not fully in view. Events in the leading
  // sliver still count toward the cards; the trailing bucket is honest as
  // today-so-far. A cutoff already on a bucket boundary keeps its bucket.
  const start =
    period === "all" ? first : Math.ceil(cutoff / bucketMs) * bucketMs;
  const end = Math.floor(now / bucketMs) * bucketMs;
  const buckets: TimelineBucket[] = [];
  const visible = new Set<string>();
  for (let at = start; at <= end; at += bucketMs) {
    const byAgent = totals.get(at) ?? {};
    for (const agent of Object.keys(byAgent)) visible.add(agent);
    buckets.push({ start: at, byAgent });
  }
  return { granularity, bucketMs, buckets, agents: [...visible].sort() };
}
