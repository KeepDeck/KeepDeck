import { formatTokens } from "../../domain/usage";
import type { UsageRow } from "../../domain/usage/history/event";
import { dimensionKey } from "../../domain/usage/stats/dimensions";
import {
  breakdown,
  costChange,
  costTimeline,
  rowsIn,
  statsTotals,
  type BreakdownRow,
} from "../../domain/usage/stats/fold";
import { statsSpans, type StatsPeriod } from "../../domain/usage/stats/period";
import { seriesColorFor } from "../usagePalette";
import { spendChartView, type SpendChartView } from "./spendChartView";
import { costCoverage, displayCost } from "./statsCost";
import { agentName, modelNames, workspaceName, type GroupName } from "./statsNames";

/**
 * The Overview tab, settled. It answers four questions and nothing else —
 * how much, how it went over the period, where and on what, how close the
 * limits are (limitsGlanceView) — and every figure on it reads without a
 * footnote; what needs one lives on a deeper tab (user review of the
 * concept, 2026-11-11: «овервью очень сильно переусложнён»).
 */

/** How many groups a short list names before folding the rest. */
export const OVERVIEW_LIST_TOP = 4;

/** A money change, in words and in the tone it is read in: spending less
 * reads as good. */
export interface ChangeView {
  text: string;
  tone: "good" | "bad" | "flat";
}

export interface FigureView {
  label: string;
  value: string;
  caption: string;
}

export interface TopListRowView extends GroupName {
  key: string;
  /** The whole name, source included, for a name the cell cuts short. */
  title: string;
  cost: string;
  /** The closing "N more" row — quieter. */
  folded: boolean;
}

export interface TopListView {
  title: string;
  rows: TopListRowView[];
}

export interface OverviewView {
  /** The headline band's accessible name. */
  label: string;
  /** The headline — the ONE comparison on the screen. */
  spent: FigureView & { change: ChangeView | null };
  figures: FigureView[];
  chart: SpendChartView | null;
  /** Each agent's spend over the period, for the chart's legend. */
  legend: { agent: string; color: string; cost: string }[];
  lists: TopListView[];
  coverage: string;
  /** What shows where the chart could not be loaded. */
  chartError: string;
}

/** What the headline is compared with, by period. Exhaustive: a new period
 * names its comparison or fails to compile. */
const COMPARED_WITH: Record<StatsPeriod, string> = {
  1: "vs yesterday at this time",
  7: "vs the 7 days before",
  30: "vs the 30 days before",
  90: "vs the 90 days before",
  all: "all recorded usage",
};

/** A relative change as the headline shows it. */
export function changeView(change: number): ChangeView {
  const pct = Math.round(change * 100);
  if (pct === 0) return { text: "±0%", tone: "flat" };
  return pct > 0 ? { text: `↑ ${pct}%`, tone: "bad" } : { text: `↓ ${-pct}%`, tone: "good" };
}

export function overviewView(
  rows: readonly UsageRow[],
  period: StatsPeriod,
  now: number,
  colors: ReadonlyMap<string, string>,
): OverviewView {
  const spans = statsSpans(period, now);
  const current = rowsIn(rows, spans.current);
  const totals = statsTotals(current);
  const prior = spans.prior === null ? null : statsTotals(rowsIn(rows, spans.prior));
  const change = costChange(totals, prior);
  const granularity = period === 1 ? "hour" : "day";
  const agents = breakdown(current, [], (row) => dimensionKey("agent", row), Infinity);
  const workspaces = breakdown(current, [], (row) => dimensionKey("workspace", row), OVERVIEW_LIST_TOP);
  const models = breakdown(current, [], (row) => dimensionKey("model", row), OVERVIEW_LIST_TOP);
  const names = modelNames(models);
  return {
    label: "Summary",
    spent: {
      label: "Spent",
      value: displayCost(totals),
      change: change === null ? null : changeView(change),
      caption:
        change === null && prior !== null ? "no comparable period before" : COMPARED_WITH[period],
    },
    figures: [
      { label: "Sessions", value: String(totals.sessions), caption: "with usage in the period" },
      { label: "Output tokens", value: formatTokens(totals.outputTokens), caption: "reasoning included" },
    ],
    chart: spendChartView(costTimeline(rows, spans.current, granularity), granularity, colors),
    legend: [...agents]
      .sort((left, right) => (left.key < right.key ? -1 : 1))
      .map((row) => ({ agent: agentName(row).name, color: seriesColorFor(colors, row.key), cost: displayCost(row) })),
    lists: [
      topList("Workspaces", workspaces, workspaceName),
      topList("Models", models, (row) => names.get(row.key) ?? { name: row.key, source: null }),
    ],
    coverage: costCoverage(totals),
    chartError: "The chart could not be loaded.",
  };
}

function topList(title: string, rows: readonly BreakdownRow[], nameOf: (row: BreakdownRow) => GroupName): TopListView {
  return {
    title,
    rows: rows.map((row) => {
      const name = nameOf(row);
      return {
        key: row.key,
        ...name,
        title: name.source === null ? name.name : `${name.name} · ${name.source}`,
        cost: displayCost(row),
        folded: row.folded > 0,
      };
    }),
  };
}
