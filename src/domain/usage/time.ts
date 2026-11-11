/**
 * Shared time units and the day rules — THE one home for them. Modules
 * once kept private copies of DAY_MS and the `floor(t / DAY) * DAY`
 * bucketing; a drift between them would silently desynchronize one
 * surface's days from another's.
 *
 * The READER'S calendar is the rule: Statistics cuts its periods, steps and
 * weeks on `localDayNumber` and its siblings, and a streak answers "did I
 * show up today" — today belongs to the person. `utcDayStart` is the older
 * aggregation boundary, still read by the achievements' per-day metrics.
 * The two carry different UNITS, which is why each one is branded below.
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
  const start = Math.floor(at / DAY_MS) * DAY_MS;
  if (!isUtcDayStart(start)) throw new Error(`${start} is not a UTC midnight`);
  return start;
}

/** Whether `value` is a UTC midnight: a whole number of days since the
 * epoch. A non-finite instant has no day; it passes through as it always
 * has, and every reader's arithmetic carries it on. */
function isUtcDayStart(value: number): value is UtcDayStart {
  return value % DAY_MS === 0 || !Number.isFinite(value);
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
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
  if (!isLocalDayNumber(day)) throw new Error(`${day} is not a day ordinal`);
  return day;
}

/** Step a day ordinal by whole days — THE one place the brand is allowed to
 * come off and go back on, so no caller has to hand-cast to walk a run. */
export function shiftDay(day: LocalDayNumber, days: number): LocalDayNumber {
  const shifted = day + days;
  if (!isLocalDayNumber(shifted)) throw new Error(`a day ordinal moves by whole days, not ${days}`);
  return shifted;
}

/**
 * The instant a READER'S calendar day begins — its local midnight, or the
 * first instant that exists when a transition skips midnight itself. The
 * inverse of [`localDayNumber`]: `localDayNumber(localDayStart(d)) === d`.
 * Built from the ordinal's calendar date, never `day * DAY_MS` shifted by an
 * offset, for the reason `localDayNumber` gives.
 */
export function localDayStart(day: LocalDayNumber): number {
  const date = new Date(day * DAY_MS);
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()).getTime();
}

/** The Monday that opens the reader's calendar week containing `day`. */
export function localWeekStart(day: LocalDayNumber): LocalDayNumber {
  const mondayOffset = (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
  return shiftDay(day, -mondayOffset);
}

/** The start of the reader's clock hour containing `at`. Local, so a
 * half-hour zone's hours start on its own half hour. */
export function localHourStart(at: number): number {
  const date = new Date(at);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/** Whether `value` is a day ordinal: a whole number. Non-finite passes, as
 * for [`isUtcDayStart`]. */
function isLocalDayNumber(value: number): value is LocalDayNumber {
  return Number.isInteger(value) || !Number.isFinite(value);
}
