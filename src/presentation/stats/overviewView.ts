import { formatTokens } from "../../domain/usage";
import type { UsageRow } from "../../domain/usage/history/event";
import { dimensionKey, type StatsDimension } from "../../domain/usage/stats/dimensions";
import { breakdown, measureChange, rowsIn, rowsOf, statsTotals, usageTimeline, type BreakdownRow } from "../../domain/usage/stats/fold";
import type { StatsMeasure } from "../../domain/usage/stats/measure";
import { statsSpans, type StatsPeriod } from "../../domain/usage/stats/period";
import { seriesColorFor } from "../usagePalette";
import { usageChartView, type UsageChartView } from "./usageChartView";
import { displayAmount, measureNote, nothingToDraw } from "./statsMeasures";
import { PERIOD_PHRASES } from "./statsPeriods";
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

/** A change, in words and in the tone it is read in (changeView). */
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
  amount: string;
  /** The closing "N more" row — quieter. */
  folded: boolean;
}

export interface TopListView {
  title: string;
  /** Said in place of the rows when the period holds no usage. */
  empty: string | null;
  /** The door to the same groups in Breakdown. */
  link: string;
  dimension: StatsDimension;
  rows: TopListRowView[];
}

export interface OverviewView {
  /** The headline band's accessible name. */
  label: string;
  /** The headline in the reader's measure — the ONE comparison on the
   * screen. */
  headline: FigureView & { change: ChangeView | null };
  figures: FigureView[];
  chart: UsageChartView;
  /** Said in place of the bars when there is nothing to draw: no usage in
   * the period, or — in money — none a price covers. The card keeps its
   * height. */
  chartNote: string | null;
  /** Each agent's amount over the period, for the chart's legend. */
  legend: { agent: string; color: string; amount: string }[];
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

/** What the headline is called in each measure. */
const HEADLINES: Record<StatsMeasure, string> = { spend: "Spent", tokens: "Tokens" };

/** A relative change as the screen shows it. Spending less reads as good;
 * tokens are the work done, not a cost — their change carries no tone. */
export function changeView(change: number, measure: StatsMeasure): ChangeView {
  const pct = Math.round(change * 100);
  if (pct === 0) return { text: "±0%", tone: "flat" };
  const text = pct > 0 ? `↑ ${pct}%` : `↓ ${-pct}%`;
  if (measure === "tokens") return { text, tone: "flat" };
  return { text, tone: pct > 0 ? "bad" : "good" };
}

export function overviewView(
  ledgerRows: readonly UsageRow[],
  input: {
    period: StatsPeriod;
    now: number;
    colors: ReadonlyMap<string, string>;
    workspace: string | null;
    measure: StatsMeasure;
  },
): OverviewView {
  const { period, now, colors, workspace, measure } = input;
  const rows = rowsOf(ledgerRows, workspace);
  const spans = statsSpans(period, now);
  const current = rowsIn(rows, spans.current);
  const totals = statsTotals(current);
  const prior = spans.prior === null ? null : statsTotals(rowsIn(rows, spans.prior));
  const change = measureChange(totals, prior, measure);
  const granularity = period === 1 ? "hour" : "day";
  const agents = breakdown(current, [], (row) => dimensionKey("agent", row), Infinity, measure);
  const workspaces = breakdown(current, [], (row) => dimensionKey("workspace", row), OVERVIEW_LIST_TOP, measure);
  const agentsTop = breakdown(current, [], (row) => dimensionKey("agent", row), OVERVIEW_LIST_TOP, measure);
  const models = breakdown(current, [], (row) => dimensionKey("model", row), OVERVIEW_LIST_TOP, measure);
  const names = modelNames(models);
  // A period with no usage — or, in money, with usage no price covers —
  // has nothing to draw or compare: said in words, never as an empty chart
  // or a "$0". Tokens are known for every row.
  const idle = current.length === 0;
  const unpriced = measure === "spend" && !idle && totals.pricedEvents === 0;
  const noUsage = `no usage ${PERIOD_PHRASES[period]}`;
  const empty = idle ? `No usage ${PERIOD_PHRASES[period]}` : null;
  return {
    label: "Summary",
    headline: {
      label: HEADLINES[measure],
      value: displayAmount(totals, measure),
      change: change === null ? null : changeView(change, measure),
      caption: idle
        ? noUsage
        : unpriced
          ? "no model here has a known price"
          : change === null && prior !== null
            ? "no comparable period before"
            : COMPARED_WITH[period],
    },
    figures: [
      { label: "Sessions", value: String(totals.sessions), caption: "with usage in the period" },
      { label: "Output tokens", value: formatTokens(totals.outputTokens), caption: "reasoning included" },
    ],
    chart: usageChartView(usageTimeline(rows, spans.current, granularity, measure), granularity, colors, measure),
    chartNote: nothingToDraw(empty, totals, measure),
    legend: [...agents]
      .sort((left, right) => (left.key < right.key ? -1 : 1))
      .map((row) => ({ agent: agentName(row).name, color: seriesColorFor(colors, row.key), amount: displayAmount(row, measure) })),
    lists: [
      // Inside one picked workspace a list of workspaces would only repeat
      // the scope; its agents say something instead.
      workspace === null
        ? topList("Workspaces", "workspace", workspaces, workspaceName, empty, measure)
        : topList("Agents", "agent", agentsTop, agentName, empty, measure),
      topList("Models", "model", models, (row) => names.get(row.key) ?? { name: row.key, source: null }, empty, measure),
    ],
    coverage: measureNote(totals, measure),
    chartError: "The chart could not be loaded.",
  };
}

function topList(
  title: string,
  dimension: StatsDimension,
  rows: readonly BreakdownRow[],
  nameOf: (row: BreakdownRow) => GroupName,
  empty: string | null,
  measure: StatsMeasure,
): TopListView {
  return {
    title,
    empty,
    link: "Breakdown →",
    dimension,
    rows: rows.map((row) => {
      const name = nameOf(row);
      return {
        key: row.key,
        ...name,
        title: name.source === null ? name.name : `${name.name} · ${name.source}`,
        amount: displayAmount(row, measure),
        folded: row.folded > 0,
      };
    }),
  };
}
