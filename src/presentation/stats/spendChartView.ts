import { formatStep, formatTokens, formatUsd } from "../../domain/usage";
import type { CostStep, TimelineGranularity } from "../../domain/usage/stats/fold";
import { seriesColorFor } from "../usagePalette";

/**
 * The money-over-time chart, settled: whether there is a chart, its title,
 * each bar's value and what the hover card says about a step. The component
 * wires these into the chart library and decides nothing.
 */

/** Exhaustive by construction: a new granularity fails to compile until it
 * names its title. */
const TITLES: Record<TimelineGranularity, string> = {
  hour: "Spend per hour",
  day: "Spend per day",
};

export interface SpendChartView {
  title: string;
  granularity: TimelineGranularity;
  /** Mutable as the chart library types its data; never written. */
  steps: CostStep[];
  /** Agents with priced spend in the steps, in a FIXED alphabetical order
   * — a period switch must not re-stack the bars. */
  agents: readonly string[];
  tick(start: number): string;
  /** A value-axis label. */
  axis(value: number): string;
  color(agent: string): string;
}

/** The chart, or none for a span with no steps at all. A span whose usage
 * is all unpriced still gets its axis: empty bars with a hover card saying
 * why, rather than a chart that vanishes. */
export function spendChartView(
  steps: CostStep[],
  granularity: TimelineGranularity,
  colors: ReadonlyMap<string, string>,
): SpendChartView | null {
  if (steps.length === 0) return null;
  const agents = new Set<string>();
  for (const step of steps) for (const agent of Object.keys(step.byAgent)) agents.add(agent);
  return {
    title: TITLES[granularity],
    granularity,
    steps,
    agents: [...agents].sort(),
    tick: (start) => formatStep(start, granularity),
    axis: (value) => formatUsd(value),
    color: (agent) => seriesColorFor(colors, agent),
  };
}

/** An agent's bar in a step: its priced spend, or none. */
export function stepValue(step: CostStep, agent: string): number {
  return step.byAgent[agent] ?? 0;
}

export interface SpendTipView {
  heading: string;
  rows: { agent: string; color: string; cost: string }[];
  /** Usage in the step that no price covers — said, never drawn as $0. */
  unpriced: string | null;
}

/** The hover card for the step starting at `start`: every agent's priced
 * spend in the chart's fixed order, and what went unpriced. None while
 * nothing is hovered or the step holds nothing at all. */
export function spendTipView(view: SpendChartView, active: boolean, start: unknown): SpendTipView | null {
  if (!active) return null;
  const step = view.steps.find((candidate) => candidate.start === start);
  if (!step || (step.pricedEvents === 0 && step.unpricedTokens === 0)) return null;
  return {
    heading: formatStep(step.start, view.granularity, "long"),
    rows: view.agents
      .filter((agent) => step.byAgent[agent] !== undefined)
      .map((agent) => ({ agent, color: view.color(agent), cost: formatUsd(stepValue(step, agent), { approx: true }) })),
    unpriced: step.unpricedTokens > 0 ? `${formatTokens(step.unpricedTokens)} tokens without a known price` : null,
  };
}
