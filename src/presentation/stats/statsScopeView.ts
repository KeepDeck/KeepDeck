import type { UsageRow } from "../../domain/usage/history/event";
import { dimensionKey } from "../../domain/usage/stats/dimensions";
import { breakdown, rowsIn } from "../../domain/usage/stats/fold";
import { statsSpans, type StatsPeriod } from "../../domain/usage/stats/period";

/**
 * The workspace scope: one-click chips beside the tabs — every workspace,
 * then the period's busiest ones, the rest behind "+N" until it is opened.
 * A picked workspace stays on screen even when it is not among the busiest.
 */

/** How many workspaces show before "+N". */
export const SCOPE_TOP = 4;

export interface ScopeChipView {
  workspace: string | null;
  label: string;
  active: boolean;
}

export interface StatsScopeView {
  label: string;
  chips: ScopeChipView[];
  /** The "+N" that shows the rest; none when nothing is held back. */
  more: string | null;
}

export function statsScopeView(
  rows: readonly UsageRow[],
  input: { period: StatsPeriod; now: number; workspace: string | null; expanded: boolean },
): StatsScopeView {
  const { period, now, workspace, expanded } = input;
  const ranked = breakdown(rowsIn(rows, statsSpans(period, now).current), [], (row) => dimensionKey("workspace", row), Infinity)
    .map((group) => group.latest.workspaceName);
  const shown = expanded ? ranked : ranked.slice(0, SCOPE_TOP);
  const names = workspace !== null && !shown.includes(workspace) ? [...shown, workspace] : shown;
  const held = ranked.filter((name) => !names.includes(name)).length;
  return {
    label: "Workspaces",
    chips: [
      { workspace: null, label: "All workspaces", active: workspace === null },
      ...names.map((name) => ({ workspace: name, label: name, active: name === workspace })),
    ],
    more: held > 0 ? `+${held}` : null,
  };
}
