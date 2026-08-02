/**
 * The Overview chart's categorical palette — entity-keyed and roster-stable.
 *
 * Deliberately NOT the agent catalog's brand colors: these slots are the
 * dataviz default categorical order, validated AS A SET against the dialog's
 * dark surface (all six checks pass — lightness band, chroma floor, adjacent
 * CVD separation ΔE 8.4 worst, normal-vision floor, contrast). Brand colors
 * were never validated together and would fail the CVD gates; the catalog
 * remains the home of per-agent brand identity, this module the home of the
 * chart's series colors.
 */

/** Built-in agents own fixed slots — a period switch or a new sibling can
 * never repaint them. */
const AGENT_SLOTS: Record<string, string> = {
  claude: "#3987e5",
  codex: "#d95926",
  kimi: "#199e70",
  opencode: "#c98500",
};

const SPARE_SLOTS = ["#d55181", "#008300", "#9085e9", "#e66767"];
export const OVERFLOW_COLOR = "#596273";

/** The dialog card surface the palette was validated against. Duplicated as
 * a TS constant because SVG fill/stroke props cannot read a CSS custom
 * property — keep in sync with `--kd-bg` in base.css. */
export const CHART_SURFACE = "#0b0e14";

/** The chart's plot height; the Suspense placeholder builds the same box
 * from this constant so the overview cannot jump when the chunk lands. */
export const CHART_HEIGHT = 190;

/* Chart CHROME — grid, axes, inks, tooltip surfaces. Beside the series
 * palette so a design pass finds every chart color in ONE module; these
 * mirror the stats stylesheets' values (SVG props cannot read CSS custom
 * properties — keep in sync when the sheets are recolored). */
export const CHART_GRID = "#171d28";
export const CHART_AXIS = "#1c2230";
export const CHART_TICK_INK = "#596273";
export const CHART_LEGEND_INK = "#9aa3af";
export const CHART_ITEM_INK = "#c5c8c6";
export const CHART_LABEL_INK = "#596273";
export const CHART_TOOLTIP_BG = "#10141c";
export const CHART_TOOLTIP_BORDER = "#1c2230";
export const CHART_CURSOR_FILL = "rgba(255, 255, 255, 0.04)";

/** THE roster rule for account-limit surfaces (Providers cards, chip
 * panel): the full ledger roster plus every currently reported agent —
 * so an account with no ledger events yet still gets its slot, and both
 * surfaces resolve identical colors from identical inputs. */
export function accountSeriesColors(
  ledgerRoster: readonly string[],
  reported: readonly string[],
): Map<string, string> {
  return agentSeriesColors([...ledgerRoster, ...reported]);
}

/** Colors for a roster of agent ids. Spare slots are handed out by an
 * agent's rank among ALL unknown agents in the roster — pass the FULL
 * ledger roster, never the selected period's subset, and a period switch
 * cannot repaint a provider. Past the spare slots the palette is exhausted
 * and overflow agents fold into gray. */
export function agentSeriesColors(
  roster: readonly string[],
): Map<string, string> {
  const distinct = [...new Set(roster)];
  // Own-property lookups only: agent ids come from plugin-declared strings,
  // and an `in`/index probe would walk the prototype ("toString" would
  // answer with a FUNCTION as its color).
  const known = (agent: string) =>
    Object.prototype.hasOwnProperty.call(AGENT_SLOTS, agent);
  const unknown = distinct.filter((agent) => !known(agent)).sort();
  const colors = new Map<string, string>();
  for (const agent of distinct) {
    colors.set(
      agent,
      (known(agent) ? AGENT_SLOTS[agent] : SPARE_SLOTS[unknown.indexOf(agent)]) ??
        OVERFLOW_COLOR,
    );
  }
  return colors;
}
