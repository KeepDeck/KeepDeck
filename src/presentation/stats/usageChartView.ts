import { formatStep, formatTokens, formatUsd } from "../../domain/usage";
import type { UsageStep, TimelineGranularity } from "../../domain/usage/stats/fold";
import type { StatsMeasure } from "../../domain/usage/stats/measure";
import { seriesColorFor } from "../usagePalette";
import { formatAmount } from "./statsMeasures";

/**
 * The usage-over-time chart, settled: its title, each bar's value in the
 * measure the reader picked, and what the hover card says about a step.
 * The component wires these into the chart library and decides nothing.
 */

/** Exhaustive by construction: a new measure or granularity fails to
 * compile until it names its title. */
const TITLES: Record<StatsMeasure, Record<TimelineGranularity, string>> = {
  spend: { hour: "Spend per hour", day: "Spend per day" },
  tokens: { hour: "Tokens per hour", day: "Tokens per day" },
};

export interface UsageChartView {
  title: string;
  measure: StatsMeasure;
  granularity: TimelineGranularity;
  /** Mutable as the chart library types its data; never written. */
  steps: UsageStep[];
  /** Agents with an amount in the steps, in a FIXED alphabetical order —
   * a period switch must not re-stack the bars. */
  agents: readonly string[];
  tick(start: number): string;
  /** A value-axis label. */
  axis(value: number): string;
  color(agent: string): string;
}

/** The chart over a span's steps, in the measure. A span with nothing to
 * draw — no usage, or none a price covers in money — is the Overview's to
 * say in words, in place of the bars (overviewView's `chartNote`); a money
 * step with unpriced usage among priced ones says so in its hover card. */
export function usageChartView(
  steps: UsageStep[],
  granularity: TimelineGranularity,
  colors: ReadonlyMap<string, string>,
  measure: StatsMeasure,
): UsageChartView {
  const agents = new Set<string>();
  for (const step of steps) for (const agent of Object.keys(step.byAgent)) agents.add(agent);
  return {
    title: TITLES[measure][granularity],
    measure,
    granularity,
    steps,
    agents: [...agents].sort(),
    tick: (start) => formatStep(start, granularity),
    axis: (value) => (measure === "spend" ? formatUsd(value) : formatTokens(value)),
    color: (agent) => seriesColorFor(colors, agent),
  };
}

/** An agent's bar in a step: its amount, or none. */
export function stepValue(step: UsageStep, agent: string): number {
  return step.byAgent[agent] ?? 0;
}

export interface UsageTipView {
  heading: string;
  rows: { agent: string; color: string; amount: string }[];
  /** Usage in a money step that no price covers — said, never drawn as $0. */
  unpriced: string | null;
}

/** The hover card for the step starting at `start`: every agent's amount
 * in the chart's fixed order, and — in money — what went unpriced. None
 * while nothing is hovered or the step holds nothing at all. */
export function usageTipView(view: UsageChartView, active: boolean, start: unknown): UsageTipView | null {
  if (!active) return null;
  const step = view.steps.find((candidate) => candidate.start === start);
  if (!step || (step.pricedEvents === 0 && step.unpricedTokens === 0)) return null;
  return {
    heading: formatStep(step.start, view.granularity, "long"),
    rows: view.agents
      .filter((agent) => step.byAgent[agent] !== undefined)
      .map((agent) => ({ agent, color: view.color(agent), amount: formatAmount(stepValue(step, agent), view.measure) })),
    unpriced:
      view.measure === "spend" && step.unpricedTokens > 0 ? `${formatTokens(step.unpricedTokens)} tokens without a known price` : null,
  };
}
