import { addCost, emptyCostTally, type CostTally, type UsageRow } from "../history/event";
import type { WindowReport } from "../reportJournal";
import { localDayNumber, localDayStart, localWeekStart, shiftDay, type LocalDayNumber } from "../time";
import { inSpan, type Span } from "./period";

/**
 * The Weekly report's folds: calendar weeks on the READER'S calendar
 * (Monday first), how the week's money fell across its days and hours, and
 * the highest limit readings seen inside it.
 */

export interface WeekSpans {
  /** The week's Monday. */
  monday: LocalDayNumber;
  current: Span;
  /** The week before, cut at the same point when the current week is still
   * running — this week so far is never set against a whole week. */
  prior: Span;
  /** The week is over. */
  complete: boolean;
}

/** The week `back` weeks before the one containing `now` (0 = this week). */
export function weekSpans(now: number, back: number): WeekSpans {
  const monday = shiftDay(localWeekStart(localDayNumber(now)), -7 * back);
  const from = localDayStart(monday);
  const priorFrom = localDayStart(shiftDay(monday, -7));
  if (back > 0) {
    return { monday, current: { from, to: localDayStart(shiftDay(monday, 7)) }, prior: { from: priorFrom, to: from }, complete: true };
  }
  const priorEnd = Math.min(priorFrom + (now - from), from - 1);
  return { monday, current: { from, to: now + 1 }, prior: { from: priorFrom, to: priorEnd + 1 }, complete: false };
}

/** How many weeks before the one containing `now` the week opening on
 * `monday` lies — a week is named by its Monday's calendar date, which names
 * the same week in any zone; a week ahead of now reads as this one. */
export function weeksBack(monday: LocalDayNumber, now: number): number {
  return Math.max(0, Math.round((localWeekStart(localDayNumber(now)) - localWeekStart(monday)) / 7));
}

/** How many weeks back the oldest row's week lies — how far the report can
 * be paged; 0 for an empty ledger. */
export function oldestWeekBack(rows: readonly UsageRow[], now: number): number {
  let oldest = Infinity;
  for (const row of rows) oldest = Math.min(oldest, row.occurredAt);
  if (!Number.isFinite(oldest) || oldest > now) return 0;
  const weeks = (localWeekStart(localDayNumber(now)) - localWeekStart(localDayNumber(oldest))) / 7;
  return Math.max(0, Math.round(weeks));
}

/** The week's money by weekday (Monday first) and by local hour — each a
 * whole cost tally, so a bin of unpriced usage alone reads as unknown, not
 * as nothing spent. */
export interface WeekRhythm {
  byWeekday: CostTally[];
  byHour: CostTally[];
}

export function weekRhythm(rows: readonly UsageRow[], span: Span): WeekRhythm {
  const byWeekday = Array.from({ length: 7 }, emptyCostTally);
  const byHour = Array.from({ length: 24 }, emptyCostTally);
  for (const row of rows) {
    if (!inSpan(row.occurredAt, span)) continue;
    const at = new Date(row.occurredAt);
    const day = byWeekday[(at.getDay() + 6) % 7];
    const hour = byHour[at.getHours()];
    if (day !== undefined) addCost(day, row);
    if (hour !== undefined) addCost(hour, row);
  }
  return { byWeekday, byHour };
}

/** A limit window's highest reading inside a span. */
export interface WindowPeak {
  /** The journal's series key. */
  key: string;
  report: WindowReport;
}

/**
 * The highest reading of every window the report journal holds inside the
 * span, the fullest first. Only what the journal still keeps: it holds a
 * window's readings for about one and a half of its lengths, so a past
 * week's 5-hour windows are gone — the caller says so rather than showing
 * nothing as zero.
 */
export function windowPeaks(byKey: ReadonlyMap<string, readonly WindowReport[]>, span: Span): WindowPeak[] {
  const peaks: WindowPeak[] = [];
  for (const [key, reports] of byKey) {
    let top: WindowReport | null = null;
    for (const report of reports) {
      if (!inSpan(report.reportedAt, span)) continue;
      if (top === null || report.usedPct > top.usedPct) top = report;
    }
    if (top !== null) peaks.push({ key, report: top });
  }
  return peaks.sort((left, right) => right.report.usedPct - left.report.usedPct);
}
