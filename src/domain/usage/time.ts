/**
 * Shared time units and the two day rules — THE one home for both. Four
 * modules (achievements, daily, recap, streak) had private copies of
 * DAY_MS and the `floor(t / DAY) * DAY` bucketing; a drift between them
 * would silently desynchronize the chart's days from the recap's and the
 * achievements' crossing dates.
 *
 * There are TWO day rules here, not one, and keeping them adjacent is what
 * makes their difference legible: `utcDayStart` is an AGGREGATION boundary
 * (charts, weeks, per-day peaks — the same data must bucket identically
 * wherever it is read), `localDayNumber` is the READER'S calendar (a streak
 * answers "did I show up today", and today belongs to the person). They
 * also carry different UNITS, which is why each one is branded below.
 */

export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * A UTC-day bucket, as the INSTANT of its midnight (unix ms, ~1.7e12).
 *
 * Branded because its twin below is an ordinal, not an instant, and both
 * would otherwise be plain `number`: keying one of the engine's per-day
 * maps with the wrong helper is off by a whole calendar and produces no
 * type error, only a wrong answer no fixture would catch.
 */
export type UtcDayStart = number & { readonly __utcDayStart: unique symbol };

/** The UTC day bucket an instant belongs to (its midnight, unix ms). */
export function utcDayStart(at: number): UtcDayStart {
  return (Math.floor(at / DAY_MS) * DAY_MS) as UtcDayStart;
}

/**
 * A calendar day in the READER'S zone, as an ORDINAL (days since the epoch,
 * ~20 700) — not an instant. See [`UtcDayStart`] for why both are branded.
 */
export type LocalDayNumber = number & {
  readonly __localDayNumber: unique symbol;
};

/**
 * Which of the READER'S calendar days an instant falls on.
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
 * The UTC bucket is not merely offset from this one, it is a DIFFERENT
 * partition, and it can merge days this one separates: at UTC+3, sessions
 * at 01:00 and 12:00 local land on two consecutive UTC days, so working
 * every OTHER local day reads as an unbroken UTC run. Measured on a
 * 40-active-day fixture: 80 consecutive UTC days, 1 local. That is the
 * direction of the correction — the UTC number was not late, it was wrong.
 *
 * Consecutive days are consecutive numbers, DST included: this counts
 * calendar days rather than dividing elapsed milliseconds, so a 23- or
 * 25-hour day still advances the count by exactly one. That is also why it
 * builds a `Date` per call rather than doing arithmetic on the instant — a
 * cached UTC offset is wrong for every instant on the far side of a
 * transition, and a streak that breaks twice a year is worse than the ~6 µs.
 */
export function localDayNumber(at: number): LocalDayNumber {
  const date = new Date(at);
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS,
  ) as LocalDayNumber;
}

/** Step a day ordinal by whole days — THE one place the brand is allowed to
 * come off and go back on, so no caller has to hand-cast to walk a run. */
export function shiftDay(day: LocalDayNumber, days: number): LocalDayNumber {
  return (day + days) as LocalDayNumber;
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
