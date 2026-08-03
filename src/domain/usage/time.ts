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

export const WEEK_MS = 7 * DAY_MS;

/** UTC Monday 00:00 of the week containing `at` — weeks are UTC buckets
 * like every stats day, so week labels can never drift off the daily
 * chart. Lives beside its day siblings: every week-shaped feature reads
 * THIS, not a private fork. */
export function utcWeekStart(at: number): number {
  const day = utcDayStart(at);
  const mondayOffset = (new Date(day).getUTCDay() + 6) % 7;
  return day - mondayOffset * DAY_MS;
}
