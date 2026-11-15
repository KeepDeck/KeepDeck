import { formatLocalDay, formatPct, formatShare, formatStep, formatTokens, formatUsd, windowLabel } from "../../domain/usage";
import { amountOf, type StatsMeasure, type UsageTally } from "../../domain/usage/stats/measure";
import type { UsageAchievementLadder } from "../../domain/usage/achievements/ladders";
import { nextAchievements } from "../../domain/usage/achievements/ladders";
import type { UsageRow } from "../../domain/usage/history/event";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { dimensionKey } from "../../domain/usage/stats/dimensions";
import {
  breakdown,
  measureChange,
  rowsIn,
  statsTotals,
  usageTimeline,
  type BreakdownRow,
  type StatsTotals,
  type UsageStep,
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
import { displayAmount, measureNote } from "./statsMeasures";
import { modelNames, teamName, type GroupName } from "./statsNames";

/**
 * The Weekly tab, settled: one calendar week as a report in the reader's
 * measure — its amount against the week before, what it went on in plain sentences, where it
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
  amount: string;
  folded: boolean;
}

export interface BarView {
  label: string;
  /** Relative to the tallest bar, 0–1; a bar with any amount keeps a
   * sliver so it never reads as none. */
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
  headline: { label: string; value: string; change: ChangeView | null; caption: string };
  lines: string[];
  calendar: { title: string; caption: string; weeks: { key: number; days: { key: number; level: number; title: string; selected: boolean }[] }[] };
  rhythm: BarsView[];
  peaks: { title: string; caption: string; rows: { key: string; label: string; pct: string }[]; empty: string | null };
  lists: { title: string; rows: WeeklyListRowView[] }[];
  badges: { title: string; link: string; rows: { id: string; title: string; pct: string }[] } | null;
  notes: string[];
}

/** The report itself — what the week came to and what it went on —
 * shared by the tab and the weekly digest, so the two can never tell one
 * week two ways. */
export interface WeekReportView {
  week: WeekSpans;
  /** The week's usage as folded — the digest words it without the dialog's
   * "+" legend. */
  totals: StatsTotals;
  headline: WeeklyView["headline"];
  lines: string[];
}

/** The report's words that change with the measure. Exhaustive: a new
 * measure names its own or fails to compile. */
const REPORT_WORDS: Record<StatsMeasure, { headline: [thatWeek: string, thisWeek: string]; share: string; day: string }> = {
  spend: { headline: ["Spent that week", "Spent this week"], share: "of the spend", day: "the costliest day" },
  tokens: { headline: ["Tokens that week", "Tokens this week"], share: "of the tokens", day: "the busiest day" },
};

export function weekReportView(rows: readonly UsageRow[], now: number, back: number, measure: StatsMeasure): WeekReportView {
  const words = REPORT_WORDS[measure];
  const week = weekSpans(now, back);
  const current = rowsIn(rows, week.current);
  const totals = statsTotals(current);
  const change = measureChange(totals, statsTotals(rowsIn(rows, week.prior)), measure);
  const days = usageTimeline(current, week.current, "day", measure);
  const top = days.reduce<UsageStep | null>((best, day) => (best === null || amountOf(day, measure) > amountOf(best, measure) ? day : best), null);
  const models = breakdown(current, [], (row) => dimensionKey("model", row), WEEKLY_LIST_TOP, measure);
  const names = modelNames(models);
  const [topModel] = models;
  const lines: string[] = [];
  if (topModel !== undefined && topModel.folded === 0 && topModel.amount > 0) {
    lines.push(
      `${names.get(topModel.key)?.name ?? topModel.key} ran ${formatShare(topModel.share)} ${words.share}; ` +
        `output was ${formatTokens(totals.outputTokens)} tokens, reasoning included.`,
    );
  }
  // What the cache saved is money; said only where money is counted.
  if (measure === "spend" && totals.pricedEvents > 0 && totals.savedUsd > 0) {
    lines.push(
      `Cache reads cost ${formatUsd(totals.savedUsd, { approx: true })} less than the same tokens as fresh input would have, at list price.`,
    );
  }
  if (totals.sessions > 0) {
    const day = top !== null && amountOf(top, measure) > 0
      ? `; ${words.day} was ${formatStep(top.start, "day", "long")} (${displayAmount(top, measure)})`
      : "";
    lines.push(`${totals.sessions} session${totals.sessions === 1 ? "" : "s"} with usage${day}.`);
  }
  return {
    week,
    totals,
    headline: {
      label: words.headline[week.complete ? 0 : 1],
      value: displayAmount(totals, measure),
      change: change === null ? null : changeView(change, measure),
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
    measure: StatsMeasure;
  },
): WeeklyView {
  const { now, teams, measure } = input;
  const monday = input.week === null ? null : localDayFromOrdinal(input.week);
  const back = monday === null ? 0 : weeksBack(monday, now);
  const report = weekReportView(rows, now, back, measure);
  const { week } = report;
  const current = rowsIn(rows, week.current);
  const totals = statsTotals(current);
  const models = breakdown(current, [], (row) => dimensionKey("model", row), WEEKLY_LIST_TOP, measure);
  const names = modelNames(models);
  const groupsOfTeams = breakdown(current, [], (row) => dimensionKey("team", row, teams), WEEKLY_LIST_TOP, measure);
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
    headline: report.headline,
    lines: report.lines,
    calendar: calendarView(rows, now, week.monday, measure),
    rhythm: [
      { title: "By day", bars: bars(rhythm.byWeekday, (i) => DAYS[i] ?? "", measure), labelled: true },
      { title: "By hour, local time", bars: bars(rhythm.byHour, (i) => `${i}:00`, measure), labelled: false },
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
      list("Teams", groupsOfTeams, (group) => teamName(group, teams, provenance.get(group.key)), measure),
      list("Models", models, (group) => names.get(group.key) ?? { name: group.key, source: null }, measure),
    ],
    badges: back === 0 ? badgesView(input.ladders) : null,
    notes: [
      measureNote(totals, measure),
      ...(inferred ? ["Teams of usage booked before teams were recorded are inferred, and marked so."] : []),
    ],
  };
}

/** What a calendar square stands for, by measure. */
const CALENDAR_CAPTIONS: Record<StatsMeasure, string> = {
  spend: "each square is a day's spend",
  tokens: "each square is a day's tokens",
};

function weekRange(from: number, to: number): string {
  return `${formatLocalDay(from)} – ${formatLocalDay(to - 1)}`;
}

function list(title: string, groups: readonly BreakdownRow[], nameOf: (group: BreakdownRow) => GroupName, measure: StatsMeasure) {
  return {
    title,
    rows: groups.map((group) => ({
      key: group.key,
      ...nameOf(group),
      share: group.folded > 0 ? "" : formatShare(group.share),
      amount: displayAmount(group, measure),
      folded: group.folded > 0,
    })),
  };
}

function bars(bins: readonly UsageTally[], labelOf: (index: number) => string, measure: StatsMeasure): BarView[] {
  const top = Math.max(...bins.map((bin) => amountOf(bin, measure)), 0);
  return bins.map((bin, index) => {
    const amount = amountOf(bin, measure);
    return {
      label: labelOf(index),
      height: top > 0 && amount > 0 ? Math.max(amount / top, 0.02) : 0,
      // The one amount display: in money, "—" for unpriced usage alone, "+" beside it.
      title: `${labelOf(index)}: ${displayAmount(bin, measure)}`,
    };
  });
}

/** The recent weeks, a square per day shaded by its amount — five levels,
 * the darkest the busiest day shown; the selected week outlined. */
function calendarView(rows: readonly UsageRow[], now: number, selected: number, measure: StatsMeasure): WeeklyView["calendar"] {
  const lastMonday = weekSpans(now, 0).monday;
  const firstMonday = shiftDay(lastMonday, -7 * (CALENDAR_WEEKS - 1));
  const steps = usageTimeline(rows, { from: localDayStart(firstMonday), to: now + 1 }, "day", measure);
  const top = Math.max(...steps.map((step) => amountOf(step, measure)), 0);
  const weeks: WeeklyView["calendar"]["weeks"] = [];
  steps.forEach((step, index) => {
    const weekIndex = Math.floor(index / 7);
    const monday = shiftDay(firstMonday, weekIndex * 7);
    weeks[weekIndex] ??= { key: monday, days: [] };
    weeks[weekIndex].days.push({
      key: step.start,
      level: top > 0 && amountOf(step, measure) > 0 ? Math.max(1, Math.ceil((amountOf(step, measure) / top) * 4)) : 0,
      title: `${formatStep(step.start, "day", "long")}: ${displayAmount(step, measure)}`,
      selected: monday === selected,
    });
  });
  return { title: `${CALENDAR_WEEKS} weeks`, caption: CALENDAR_CAPTIONS[measure], weeks };
}

function badgesView(ladders: readonly UsageAchievementLadder[]): WeeklyView["badges"] {
  const next = nextAchievements(ladders)
    .map((tier) => ({ tier, share: tier.threshold > 0 ? Math.min(1, tier.progress / tier.threshold) : 0 }))
    .sort((left, right) => right.share - left.share)
    .slice(0, BADGES_SHOWN);
  return {
    title: "Closest to the next badge",
    link: "All →",
    rows: next.map(({ tier, share }) => ({ id: tier.id, title: tier.title, pct: formatShare(share) })),
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
  // The digest tells the week's money: a notification has no switch.
  const report = weekReportView(rows, now, 1, "spend");
  if (report.lines.length === 0) return null;
  const { headline, week, totals } = report;
  const change = headline.change === null ? "" : ` (${headline.change.text} ${headline.caption})`;
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
