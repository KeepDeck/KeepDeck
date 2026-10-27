import { usageAgents } from "../domain/usage/daily";
import type { UsageEventV2 } from "../domain/usage/history/event";

/**
 * The usage charts' series colours — one map every surface shares (the
 * chart, the provider cards, the chips panel, the weeks bars), so they can
 * never disagree on a hue.
 *
 * An agent's plugin declares its colour (`presentation.chartColor`); the
 * built-in four are the dataviz default categorical order, validated AS A
 * SET against the dialog's dark surface. An installed agent that declares
 * none takes a spare slot by its rank among such agents in the catalog —
 * never by the period's subset or the clock. An agent the catalog does not
 * have (its plugin disabled or gone) is gray: its history stands, but it is
 * no longer one of the deck's agents.
 */

export const SPARE_SLOTS = ["#d55181", "#008300", "#9085e9", "#e66767"];
export const OVERFLOW_COLOR = "#596273";

/** What colouring needs of the catalog: who is installed, and what each
 * declared. */
export interface PaletteAgent {
  id: string;
  chartColor?: string;
}

/** Colours for every agent of the ledger and of the catalog. */
export function usageSeriesColors(
  events: readonly UsageEventV2[],
  catalog: readonly PaletteAgent[],
): Map<string, string> {
  const unhinted = catalog
    .filter((agent) => agent.chartColor === undefined)
    .map((agent) => agent.id)
    .sort();
  const colors = new Map<string, string>();
  for (const agent of catalog) {
    colors.set(agent.id, agent.chartColor ?? SPARE_SLOTS[unhinted.indexOf(agent.id)] ?? OVERFLOW_COLOR);
  }
  for (const agent of usageAgents(events)) {
    if (!colors.has(agent)) colors.set(agent, OVERFLOW_COLOR);
  }
  return colors;
}

/** One agent's colour from that map — gray for an id it does not hold. */
export function seriesColorFor(colors: ReadonlyMap<string, string>, agent: string): string {
  return colors.get(agent) ?? OVERFLOW_COLOR;
}
