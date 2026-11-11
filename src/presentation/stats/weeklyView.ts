import { formatLocalDay, formatPct, formatStep, formatTokens, formatUsd, windowLabel } from "../../domain/usage";
import type { UsageAchievementLadder } from "../../domain/usage/achievements/ladders";
import { nextAchievements } from "../../domain/usage/achievements/ladders";
import type { UsageRow } from "../../domain/usage/history/event";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { dimensionKey } from "../../domain/usage/stats/dimensions";
import {
  breakdown,
  costChange,
  costTimeline,
  rowsIn,
  statsTotals,
  type BreakdownRow,
  type CostStep,
} from "../../domain/usage/stats/fold";
import { rowTeam, type TeamHistory } from "../../domain/usage/stats/teams";
import { oldestWeekBack, weekRhythm, weekSpans, windowPeaks } from "../../domain/usage/stats/weekly";
import { localDayStart, shiftDay } from "../../domain/usage/time";
import { changeView, type ChangeView } from "./overviewView";
import { costCoverage, displayCost } from "./statsCost";
import { modelNames, teamName, type GroupName } from "./statsNames";

/**
 * The Weekly tab, settled: one calendar week as a report — its money
 * against the week before, what it went on in plain sentences, where it
 * sits among the recent weeks, its rhythm, the fullest limit readings seen
 * in it, and (this week) the badges nearest to falling.
 */

/** How many weeks the calendar shows, and how many groups each list names. */
export const CALENDAR_WEEKS = 18;
export const WEEKLY_LIST_TOP = 3;
export const BADGES_SHOWN = 4;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface WeeklyListRowView extends GroupName {
  key: string;
  share: string;
  cost: string;
  folded: boolean;
}

export interface BarView {
  label: string;
  /** Relative to the tallest bar, 0–1; a bar with any money keeps a sliver
   * so it never reads as none. */
  height: number;
  title: string;
}

export interface BarsView {
  title: string;
  bars: BarView[];
  /** Whether each bar names itself under it — not 24 hour numbers. */
  labelled: boolean;
}

export interface WeeklyView {
  /** The weeks the arrows go to — null where there is none. */
  nav: { label: string; older: number | null; newer: number | null; olderLabel: string; newerLabel: string };
  spent: { label: string; value: string; change: ChangeView | null; caption: string };
  lines: string[];
  calendar: { title: string; caption: string; weeks: { key: number; days: { key: number; level: number; title: string; selected: boolean }[] }[] };
  rhythm: BarsView[];
  peaks: { title: string; caption: string; rows: { key: string; label: string; pct: string }[]; empty: string | null };
  lists: { title: string; rows: WeeklyListRowView[] }[];
  badges: { title: string; link: string; rows: { id: string; title: string; pct: string }[] } | null;
  notes: string[];
}

export function weeklyView(
  rows: readonly UsageRow[],
  input: {
    now: number;
    /** How many weeks back from this one (0 = this week). */
    back: number;
    teams: TeamHistory;
    reports: ReadonlyMap<string, readonly WindowReport[]>;
    /** The badge ladders as of now — only this week shows how close they are. */
    ladders: readonly UsageAchievementLadder[];
  },
): WeeklyView {
  const { now, back, teams } = input;
  const week = weekSpans(now, back);
  const current = rowsIn(rows, week.current);
  const totals = statsTotals(current);
  const change = costChange(totals, statsTotals(rowsIn(rows, week.prior)));
  const days = costTimeline(current, week.current, "day");
  const costliest = days.reduce<CostStep | null>((top, day) => (top === null || day.costUsd > top.costUsd ? day : top), null);
  const models = breakdown(current, [], (row) => dimensionKey("model", row), WEEKLY_LIST_TOP);
  const groupsOfTeams = breakdown(current, [], (row) => dimensionKey("team", row, teams), WEEKLY_LIST_TOP);
  const names = modelNames(models);
  const [topModel] = models;
  const lines: string[] = [];
  if (topModel !== undefined && topModel.folded === 0 && topModel.pricedEvents > 0) {
    lines.push(
      `${names.get(topModel.key)?.name ?? topModel.key} ran ${pct(topModel.share)} of the spend; ` +
        `output was ${formatTokens(totals.outputTokens)} tokens, reasoning included.`,
    );
  }
  if (totals.pricedEvents > 0 && totals.savedUsd > 0) {
    lines.push(
      `Cache reads cost ${formatUsd(totals.savedUsd, { approx: true })} less than the same tokens as fresh input would have, at list price.`,
    );
  }
  if (totals.sessions > 0) {
    const day = costliest !== null && costliest.pricedEvents > 0
      ? `; the costliest day was ${formatStep(costliest.start, "day", "long")} (${displayCost(costliest)})`
      : "";
    lines.push(`${totals.sessions} session${totals.sessions === 1 ? "" : "s"} with usage${day}.`);
  }
  const peaks = windowPeaks(input.reports, week.current);
  const rhythm = weekRhythm(current, week.current);
  const inferred = groupsOfTeams.some((group) => {
    const { source } = rowTeam(group.latest, teams);
    return group.folded === 0 && (source === "journal" || source === "branch");
  });
  return {
    nav: {
      label: back === 0 ? `This week · ${formatLocalDay(week.current.from)} – today` : weekRange(week.current.from, week.current.to),
      older: back < oldestWeekBack(rows, now) ? back + 1 : null,
      newer: back > 0 ? back - 1 : null,
      olderLabel: "Earlier week",
      newerLabel: "Later week",
    },
    spent: {
      label: week.complete ? "Spent that week" : "Spent this week",
      value: displayCost(totals),
      change: change === null ? null : changeView(change),
      caption: change === null ? "no comparable week before" : week.complete ? "vs the week before" : "vs last week at this point",
    },
    lines,
    calendar: calendarView(rows, now, week.monday),
    rhythm: [
      { title: "By day", bars: bars(rhythm.byWeekday, (i) => DAYS[i] ?? ""), labelled: true },
      { title: "By hour, local time", bars: bars(rhythm.byHour, (i) => `${i}:00`), labelled: false },
    ],
    peaks: {
      title: "Limits — highest readings",
      caption: "as reported in the week",
      rows: peaks.map((peak) => ({
        key: peak.key,
        label: `${peak.report.agent} ${windowLabel(peak.report, "long")}`,
        pct: formatPct(peak.report.usedPct, "used"),
      })),
      empty: peaks.length > 0 ? null : week.complete ? "Readings for this week are no longer kept." : "No limit readings yet this week.",
    },
    lists: [
      list("Teams", groupsOfTeams, (group) => teamName(group, teams)),
      list("Models", models, (group) => names.get(group.key) ?? { name: group.key, source: null }),
    ],
    badges: back === 0 ? badgesView(input.ladders) : null,
    notes: [
      costCoverage(totals),
      ...(inferred ? ["Teams of usage booked before teams were recorded are inferred, and marked so."] : []),
    ],
  };
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

function weekRange(from: number, to: number): string {
  return `${formatLocalDay(from)} – ${formatLocalDay(to - 1)}`;
}

function list(title: string, groups: readonly BreakdownRow[], nameOf: (group: BreakdownRow) => GroupName) {
  return {
    title,
    rows: groups.map((group) => ({
      key: group.key,
      ...nameOf(group),
      share: group.folded > 0 ? "" : pct(group.share),
      cost: displayCost(group),
      folded: group.folded > 0,
    })),
  };
}

function bars(values: readonly number[], labelOf: (index: number) => string): BarView[] {
  const top = Math.max(...values, 0);
  return values.map((value, index) => ({
    label: labelOf(index),
    height: top > 0 && value > 0 ? Math.max(value / top, 0.02) : 0,
    title: `${labelOf(index)}: ${formatUsd(value, { approx: true })}`,
  }));
}

/** The recent weeks, a square per day shaded by its spend — five levels,
 * the darkest the busiest day shown; the selected week outlined. */
function calendarView(rows: readonly UsageRow[], now: number, selected: number): WeeklyView["calendar"] {
  const lastMonday = weekSpans(now, 0).monday;
  const firstMonday = shiftDay(lastMonday, -7 * (CALENDAR_WEEKS - 1));
  const steps = costTimeline(rows, { from: localDayStart(firstMonday), to: now + 1 }, "day");
  const top = Math.max(...steps.map((step) => step.costUsd), 0);
  const weeks: WeeklyView["calendar"]["weeks"] = [];
  steps.forEach((step, index) => {
    const weekIndex = Math.floor(index / 7);
    const monday = shiftDay(firstMonday, weekIndex * 7);
    weeks[weekIndex] ??= { key: monday, days: [] };
    weeks[weekIndex].days.push({
      key: step.start,
      level: top > 0 && step.costUsd > 0 ? Math.max(1, Math.ceil((step.costUsd / top) * 4)) : 0,
      title: `${formatStep(step.start, "day", "long")}: ${displayCost(step)}`,
      selected: monday === selected,
    });
  });
  return { title: `${CALENDAR_WEEKS} weeks`, caption: "each square is a day's spend", weeks };
}

function badgesView(ladders: readonly UsageAchievementLadder[]): WeeklyView["badges"] {
  const next = nextAchievements(ladders)
    .map((tier) => ({ tier, share: tier.threshold > 0 ? Math.min(1, tier.progress / tier.threshold) : 0 }))
    .sort((left, right) => right.share - left.share)
    .slice(0, BADGES_SHOWN);
  return {
    title: "Closest to the next badge",
    link: "All →",
    rows: next.map(({ tier, share }) => ({ id: tier.id, title: tier.title, pct: pct(share) })),
  };
}
