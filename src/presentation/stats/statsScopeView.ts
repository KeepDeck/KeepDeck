import { formatShare } from "../../domain/usage";
import type { UsageRow } from "../../domain/usage/history/event";
import { dimensionKey } from "../../domain/usage/stats/dimensions";
import { breakdown, rowsIn, statsTotals } from "../../domain/usage/stats/fold";
import { statsSpans, type StatsPeriod } from "../../domain/usage/stats/period";
import { STATS_TAB_IDS, type StatsTab } from "../../domain/usage/statsTabs";
import { displayCost } from "./statsCost";
import { PERIOD_PHRASES } from "./statsPeriods";
import { TAB_SPECS } from "./statsTabs";

/**
 * The workspace scope: one menu beside the period switcher — the two
 * lenses on the numbers, side by side. The closed control names what the
 * numbers are narrowed to; the menu lists every workspace with usage in
 * the period, by spend, with its money and share, so a pick is never
 * blind. A picked workspace stays listed when the period holds none of its
 * usage. On a tab that never narrows the control idles, as the period
 * switcher does, and keeps the pick.
 */

/** The option value of "every workspace" — no workspace name can be it. */
const EVERY = "\0every";

export type ScopeOptionView =
  | { kind: "every"; value: string; name: string; money: string }
  | { kind: "spent"; value: string; name: string; money: string; share: string; bar: number }
  | { kind: "silent"; value: string; name: string; note: string };

export interface StatsScopeView {
  /** The control's accessible name. */
  label: string;
  /** The picked option's value. */
  value: string;
  options: ScopeOptionView[];
  /** The tab never narrows: the control shows the pick and opens nothing. */
  idle: boolean;
  /** The way back to every workspace, named; none while every workspace
   * shows, or while the control idles. */
  clear: string | null;
  /** What a pick narrows, and what it never does. */
  note: string;
}

export function statsScopeView(
  rows: readonly UsageRow[],
  input: { tab: StatsTab; period: StatsPeriod; now: number; workspace: string | null },
): StatsScopeView {
  const { tab, period, now, workspace } = input;
  const inPeriod = rowsIn(rows, statsSpans(period, now).current);
  const ranked = breakdown(inPeriod, [], (row) => dimensionKey("workspace", row), Infinity);
  const options: ScopeOptionView[] = [
    { kind: "every", value: EVERY, name: "All workspaces", money: displayCost(statsTotals(inPeriod)) },
    ...ranked.map((group): ScopeOptionView => ({
      kind: "spent",
      value: group.key,
      name: group.latest.workspaceName,
      money: displayCost(group),
      share: formatShare(group.share),
      bar: group.share,
    })),
  ];
  if (workspace !== null && !ranked.some((group) => group.key === workspace)) {
    options.push({ kind: "silent", value: workspace, name: workspace, note: `no usage ${PERIOD_PHRASES[period]}` });
  }
  const idle = TAB_SPECS[tab].scoped !== true;
  return {
    label: "Workspaces",
    value: workspace ?? EVERY,
    options,
    idle,
    clear: workspace === null || idle ? null : "Show every workspace",
    note: SCOPE_NOTE,
  };
}

/** The workspace an option stands for — none for every workspace. */
export function scopeWorkspace(value: string): string | null {
  return value === EVERY ? null : value;
}

const tabList = (tabs: readonly StatsTab[]) => {
  const labels = tabs.map((tab) => TAB_SPECS[tab].label);
  return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
};

/** Read off the tab table, never hand-listed: a tab that starts narrowing
 * moves sides here by itself. */
const SCOPE_NOTE = `Narrows ${tabList(STATS_TAB_IDS.filter((tab) => TAB_SPECS[tab].scoped === true))}. ${tabList(
  STATS_TAB_IDS.filter((tab) => TAB_SPECS[tab].scoped !== true),
)} always count every workspace.`;
