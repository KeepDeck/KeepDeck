import { localDayNumber, localDayStart, shiftDay } from "../time";

/**
 * The Statistics period, on the READER'S calendar: today, the last 7, 30
 * or 90 calendar days with today among them, or the whole ledger. Calendar
 * days rather than a rolling window, so "7 days" starts at a midnight the
 * reader can name and the chart's first bar is a whole day.
 */
export type StatsPeriod = 1 | 7 | 30 | 90 | "all";

/** A half-open stretch of time, `[from, to)`. */
export interface Span {
  from: number;
  to: number;
}

export interface StatsSpans {
  current: Span;
  /** What the period is compared with — null for "all", which has no
   * predecessor. */
  prior: Span | null;
}

export function inSpan(at: number, span: Span): boolean {
  return at >= span.from && at < span.to;
}

/**
 * The period ending at `now`, and the stretch it is compared with: the same
 * number of calendar days just before it, cut at the SAME point of its last
 * day — today-so-far is never set against a whole day. "The same point" is
 * the time elapsed since that day's start, which every day has, so a day
 * that skipped or repeated an hour needs no special case; it is clamped to
 * the prior day's own length.
 */
export function statsSpans(period: StatsPeriod, now: number): StatsSpans {
  const current: Span = { from: -Infinity, to: now + 1 };
  if (period === "all") return { current, prior: null };
  const today = localDayNumber(now);
  const first = shiftDay(today, -(period - 1));
  const priorLast = shiftDay(today, -period);
  const elapsed = now - localDayStart(today);
  const priorEnd = Math.min(localDayStart(priorLast) + elapsed, localDayStart(shiftDay(priorLast, 1)) - 1);
  return {
    current: { from: localDayStart(first), to: now + 1 },
    prior: { from: localDayStart(shiftDay(first, -period)), to: priorEnd + 1 },
  };
}
