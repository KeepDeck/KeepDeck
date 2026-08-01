/**
 * Shared time units and the UTC-day bucket rule — THE one home. Four
 * modules (achievements, daily, recap, streak) had private copies of
 * DAY_MS and the `floor(t / DAY) * DAY` bucketing; a drift between them
 * would silently desynchronize the chart's days from the recap's and the
 * achievements' crossing dates.
 */

export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;

/** The UTC day bucket an instant belongs to (its midnight, unix ms). */
export function utcDayStart(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}
