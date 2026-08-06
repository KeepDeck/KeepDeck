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

/**
 * Which of the READER'S calendar days an instant falls on, as a day number.
 *
 * Not the same question as `utcDayStart`, and the difference is the whole
 * point. A UTC bucket is an aggregation boundary: charts and weeks use it so
 * the same data buckets identically wherever it is read. A streak is not an
 * aggregation — it is "did I show up today", and today is a fact about the
 * person's own calendar. At UTC+3 the UTC day turns over at 03:00 local, so
 * a session at half past midnight counted toward yesterday and the day it
 * actually happened on looked empty; far enough west the reverse, with an
 * evening session already landing on tomorrow.
 *
 * Consecutive days are consecutive numbers, DST included: this counts
 * calendar days rather than dividing elapsed milliseconds, so a 23- or
 * 25-hour day still advances the count by exactly one.
 */
export function localDayNumber(at: number): number {
  const date = new Date(at);
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS,
  );
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
