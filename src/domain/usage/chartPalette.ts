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
const OVERFLOW_COLOR = "#596273";

/** The dialog card surface the palette was validated against. Duplicated as
 * a TS constant because SVG fill/stroke props cannot read a CSS custom
 * property — keep in sync with `--kd-bg` in base.css. */
export const CHART_SURFACE = "#0b0e14";

/** Colors for a roster of agent ids. Spare slots are handed out by an
 * agent's rank among ALL unknown agents in the roster — pass the FULL
 * ledger roster, never the selected period's subset, and a period switch
 * cannot repaint a provider. Past the spare slots the palette is exhausted
 * and overflow agents fold into gray. */
export function agentSeriesColors(
  roster: readonly string[],
): Map<string, string> {
  const distinct = [...new Set(roster)];
  const unknown = distinct.filter((agent) => !(agent in AGENT_SLOTS)).sort();
  const colors = new Map<string, string>();
  for (const agent of distinct) {
    colors.set(
      agent,
      AGENT_SLOTS[agent] ?? SPARE_SLOTS[unknown.indexOf(agent)] ?? OVERFLOW_COLOR,
    );
  }
  return colors;
}
