import { formatTokens, formatUtcDay } from "../../domain/usage";
import { DAY_MS, utcWeekStart } from "../../domain/usage/time";
import {
  DAYS_PER_WEEK,
  weekAwaitingUsage,
  weekDaysElapsed,
  type UsageWeek,
} from "../../domain/usage/weeks";
import { seriesColorFor } from "../usagePalette";
import { displayCost } from "./statsCost";

/**
 * The Weeks block at the bottom of Overview, settled: which rows the page
 * shows, what each says, how long its bar is, and where the pager goes.
 * The component renders this; page state stays with it.
 */

/** Rows per page — the block's height is CONSTANT however much history
 * accumulates; older weeks live behind the pager, never behind growth or
 * an inner scrollbar (user decision). */
export const WEEKS_PAGE = 8;

/** The shortest a non-empty bar is drawn, as a percent of the widest: a
 * week that used anything stays visible beside a huge one. */
const MIN_BAR_PCT = 2;

/** "Jul 27 – Aug 2", the year joining once the week no longer reaches
 * `now`'s ("Sep 8 – Sep 14 · 2025"). The suffix names the END's year: a
 * New-Year week is CURRENT while its Sunday sits in this year, and
 * wearing last year's suffix made the in-progress row read historical.
 * Both ends labeled in UTC like every stats day bucket. */
export function formatWeekLabel(start: number, now: number): string {
  // The week in progress is named by its RELATION to now, not by its dates.
  // That is what carries "still filling" — the row used to say it by going
  // translucent, which in an interface means disabled, not unfinished.
  if (start === utcWeekStart(now)) return "This week";
  const end = start + 6 * DAY_MS;
  const range = `${formatUtcDay(start)} – ${formatUtcDay(end)}`;
  const year = new Date(end).getUTCFullYear();
  return year === new Date(now).getUTCFullYear() ? range : `${range} · ${year}`;
}

/** "2 of 7 days" — what an in-progress week says where a completed one
 * shows its delta. The cell is the same cell: a week with nothing to
 * compare against still has something true to report. */
export function weekProgressCaption(start: number, now: number): string {
  return `${weekDaysElapsed(start, now)} of ${DAYS_PER_WEEK} days`;
}

/** "↑ +18%" / "↓ -41%" / a flat "0%" — the row's week-over-week clause,
 * sign convention shared with the recap's delta. Zero wears NO arrow: a
 * week down by half a percent rounds to -0, and `-0 >= 0` once pinned an
 * UP arrow on a decline (review finding). An incomparable week gets an
 * EMPTY cell, not a dash: a placeholder pretending to be a value breaks
 * the column's alignment rhythm. */
export function weekDeltaCaption(deltaPct: number | null): string {
  if (deltaPct === null) return "";
  if (deltaPct === 0) return "0%";
  return deltaPct > 0 ? `↑ +${deltaPct}%` : `↓ -${Math.abs(deltaPct)}%`;
}

/** The empty in-progress row's line: an honest empty state, not a
 * zero-and-dash husk. */
export const WEEK_IN_PROGRESS = "in progress · no usage yet";

/** A week's bar: its length against the widest week, and the agents that
 * burned it — the bar and the tip that explains it read the same segments. */
export interface WeekBarView {
  widthPct: number;
  /** The tip's heading: the week's label. */
  label: string;
  segments: { agent: string; tokens: number; color: string; caption: string }[];
}

export type WeekRowView =
  | { kind: "awaiting"; start: number; label: string; line: string }
  | {
      kind: "week";
      start: number;
      label: string;
      tokens: string;
      /** None for a week that used nothing. */
      bar: WeekBarView | null;
      /** The rest of the week in progress, drawn as room rather than as
       * absence: without it a short bar reads as a quiet week instead of an
       * unfinished one. */
      rest: boolean;
      /** The in-progress week's days, or a finished week's delta. */
      trend: { kind: "progress" | "delta"; text: string };
      /** The week's heaviest model by tokens, or a dash. */
      model: { kind: "model"; name: string; count: string } | { kind: "none"; text: string };
      cost: string;
    };

/** One step of the pager: the page it goes to, or none at the end. */
export interface WeeksPagerStep {
  label: string;
  glyph: string;
  to: number | null;
}

export interface WeeksPageView {
  title: string;
  /** The page shown — a page past the end shows the last one. */
  page: number;
  rows: WeekRowView[];
  /** Only when there is more than one page. */
  pager: { range: string; newer: WeeksPagerStep; older: WeeksPagerStep } | null;
}

function weekBar(week: UsageWeek, max: number, label: string, colors: ReadonlyMap<string, string>): WeekBarView {
  return {
    widthPct: Math.max(MIN_BAR_PCT, Math.round((week.totalTokens / max) * 100)),
    label,
    segments: week.segments.map((segment) => ({
      agent: segment.agent,
      tokens: segment.totalTokens,
      color: seriesColorFor(colors, segment.agent),
      caption: `${segment.agent} · ${formatTokens(segment.totalTokens)}`,
    })),
  };
}

function weekRow(week: UsageWeek, max: number, now: number, colors: ReadonlyMap<string, string>): WeekRowView {
  const label = formatWeekLabel(week.start, now);
  if (weekAwaitingUsage(week)) return { kind: "awaiting", start: week.start, label, line: WEEK_IN_PROGRESS };
  return {
    kind: "week",
    start: week.start,
    label,
    tokens: formatTokens(week.totalTokens),
    bar: week.totalTokens > 0 ? weekBar(week, max, label, colors) : null,
    rest: week.current,
    trend: week.current
      ? { kind: "progress", text: weekProgressCaption(week.start, now) }
      : { kind: "delta", text: weekDeltaCaption(week.deltaPct) },
    model: week.topModel
      ? { kind: "model", name: week.topModel.model, count: `· ${formatTokens(week.topModel.totalTokens)}` }
      : { kind: "none", text: "—" },
    cost: displayCost(week),
  };
}

/** The page `page` of the weeks, or null when there is no week to show.
 * Bars are scaled against the widest week of ALL pages, so a page's bars
 * compare with the next page's. */
export function weeksPageView(
  weeks: readonly UsageWeek[],
  page: number,
  now: number,
  colors: ReadonlyMap<string, string>,
): WeeksPageView | null {
  if (weeks.length === 0) return null;
  const pages = Math.ceil(weeks.length / WEEKS_PAGE);
  // The ledger only grows, but clamp anyway — a stale page must show the
  // last page, not an empty one.
  const shown = Math.min(Math.max(page, 0), pages - 1);
  const from = shown * WEEKS_PAGE;
  const slice = weeks.slice(from, from + WEEKS_PAGE);
  const max = Math.max(...weeks.map((week) => week.totalTokens));
  return {
    title: "Weeks",
    page: shown,
    rows: slice.map((week) => weekRow(week, max, now, colors)),
    pager:
      pages > 1
        ? {
            range: `${from + 1}–${from + slice.length} of ${weeks.length}`,
            newer: { label: "Newer weeks", glyph: "‹", to: shown > 0 ? shown - 1 : null },
            older: { label: "Older weeks", glyph: "›", to: shown < pages - 1 ? shown + 1 : null },
          }
        : null,
  };
}
