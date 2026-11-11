import { formatLocalDay, formatPct, formatStep, formatTokens, formatUsd, windowLabel } from "../../domain/usage";
import type { UsageAchievementLadder } from "../../domain/usage/achievements/ladders";
import { nextAchievements } from "../../domain/usage/achievements/ladders";
import type { CostTally, UsageRow } from "../../domain/usage/history/event";
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
  type StatsTotals,
} from "../../domain/usage/stats/fold";
import { teamProvenance, type TeamHistory } from "../../domain/usage/stats/teams";
import {
  oldestWeekBack,
  weekRhythm,
  weekSpans,
  weeksBack,
  windowPeaks,
  type WeekSpans,
} from "../../domain/usage/stats/weekly";
import { localDayFromOrdinal, localDayStart, shiftDay } from "../../domain/usage/time";
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
  /** The weeks the arrows go to, by their Monday's day ordinal — `week:
   * null` is this week, which follows the calendar; an arrow with nowhere to
   * go is null. */
  nav: {
    label: string;
    older: { week: number } | null;
    newer: { week: number | null } | null;
    olderLabel: string;
    newerLabel: string;
  };
  spent: { label: string; value: string; change: ChangeView | null; caption: string };
  lines: string[];
  calendar: { title: string; caption: string; weeks: { key: number; days: { key: number; level: number; title: string; selected: boolean }[] }[] };
  rhythm: BarsView[];
  peaks: { title: string; caption: string; rows: { key: string; label: string; pct: string }[]; empty: string | null };
  lists: { title: string; rows: WeeklyListRowView[] }[];
  badges: { title: string; link: string; rows: { id: string; title: string; pct: string }[] } | null;
  notes: string[];
}

/** The report itself — what the week cost and what it went on — shared by
 * the tab and the weekly digest, so the two can never tell one week two
 * ways. */
export interface WeekReportView {
  week: WeekSpans;
  /** The week's money as folded — the digest words it without the dialog's
   * "+" legend. */
  totals: StatsTotals;
  spent: WeeklyView["spent"];
  lines: string[];
}

export function weekReportView(rows: readonly UsageRow[], now: number, back: number): WeekReportView {
  const week = weekSpans(now, back);
  const current = rowsIn(rows, week.current);
  const totals = statsTotals(current);
  const change = costChange(totals, statsTotals(rowsIn(rows, week.prior)));
  const days = costTimeline(current, week.current, "day");
  const costliest = days.reduce<CostStep | null>((top, day) => (top === null || day.costUsd > top.costUsd ? day : top), null);
  const models = breakdown(current, [], (row) => dimensionKey("model", row), WEEKLY_LIST_TOP);
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
  return {
    week,
    totals,
    spent: {
      label: week.complete ? "Spent that week" : "Spent this week",
      value: displayCost(totals),
      change: change === null ? null : changeView(change),
      caption: change === null ? "no comparable week before" : week.complete ? "vs the week before" : "vs last week at this point",
    },
    lines,
  };
}

export function weeklyView(
  rows: readonly UsageRow[],
  input: {
    now: number;
    /** The reported week's Monday as a day ordinal, or null for this week. */
    week: number | null;
    teams: TeamHistory;
    reports: ReadonlyMap<string, readonly WindowReport[]>;
    /** The badge ladders as of now — only this week shows how close they are. */
    ladders: readonly UsageAchievementLadder[];
  },
): WeeklyView {
  const { now, teams } = input;
  const monday = input.week === null ? null : localDayFromOrdinal(input.week);
  const back = monday === null ? 0 : weeksBack(monday, now);
  const report = weekReportView(rows, now, back);
  const { week } = report;
  const current = rowsIn(rows, week.current);
  const totals = statsTotals(current);
  const models = breakdown(current, [], (row) => dimensionKey("model", row), WEEKLY_LIST_TOP);
  const names = modelNames(models);
  const groupsOfTeams = breakdown(current, [], (row) => dimensionKey("team", row, teams), WEEKLY_LIST_TOP);
  const peaks = windowPeaks(input.reports, week.current);
  const rhythm = weekRhythm(current, week.current);
  const provenance = teamProvenance(current, teams);
  const inferred = [...provenance.values()].some((p) => p !== "recorded");
  return {
    nav: {
      label: back === 0 ? `This week · ${formatLocalDay(week.current.from)} – today` : weekRange(week.current.from, week.current.to),
      older: back < oldestWeekBack(rows, now) ? { week: shiftDay(week.monday, -7) } : null,
      newer: back === 0 ? null : { week: back === 1 ? null : shiftDay(week.monday, 7) },
      olderLabel: "Earlier week",
      newerLabel: "Later week",
    },
    spent: report.spent,
    lines: report.lines,
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
      list("Teams", groupsOfTeams, (group) => teamName(group, teams, provenance.get(group.key))),
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

function bars(bins: readonly CostTally[], labelOf: (index: number) => string): BarView[] {
  const top = Math.max(...bins.map((bin) => bin.costUsd), 0);
  return bins.map((bin, index) => ({
    label: labelOf(index),
    height: top > 0 && bin.costUsd > 0 ? Math.max(bin.costUsd / top, 0.02) : 0,
    // The one money display: "—" for unpriced usage alone, "+" beside it.
    title: `${labelOf(index)}: ${displayCost(bin)}`,
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

/** The weekly digest: the last whole week's report as one notification —
 * the same words the Weekly tab says of that week. None for a week with no
 * usage: there is nothing to tell. */
export interface WeeklyDigestView {
  /** The reported week's Monday as a day ordinal — the click opens Weekly
   * on it, and the digest is told once per it, whatever zone reads it. */
  week: number;
  title: string;
  body: string;
}

export function weeklyDigestView(rows: readonly UsageRow[], now: number): WeeklyDigestView | null {
  const report = weekReportView(rows, now, 1);
  if (report.lines.length === 0) return null;
  const { spent, week, totals } = report;
  const change = spent.change === null ? "" : ` (${spent.change.text} ${spent.caption})`;
  // A notification has no coverage note to explain a "+": it says it.
  const money =
    totals.pricedEvents === 0
      ? "Usage on models without a known price only"
      : `${formatUsd(totals.costUsd, { approx: true })} spent${totals.unpricedTokens > 0 ? ", plus usage on models without a known price" : ""}`;
  return {
    week: week.monday,
    title: `Your week in KeepDeck · ${weekRange(week.current.from, week.current.to)}`,
    body: [`${money}${change}.`, report.lines[0]].join(" "),
  };
}
