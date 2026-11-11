import { formatLocalDay } from "../../domain/usage";
import { statsSpans, type StatsPeriod } from "../../domain/usage/stats/period";
import { STATS_TAB_IDS, type StatsTab } from "../../domain/usage/statsTabs";
import { PERIOD_LABELS, USAGE_PERIODS } from "./statsPeriods";
import { periodless, TAB_SPECS } from "./statsTabs";

/**
 * The Statistics dialog's shell, settled: its words, the period switcher,
 * the tab strip, and what the tab panel shows before a tab body — loading,
 * a dead ledger, an empty period, a partial-history warning. The component
 * wires state and focus; it decides none of this.
 */

/** The dialog frame's words. */
export const STATS_DIALOG = {
  title: "Statistics",
  close: "Close statistics",
  done: "Done",
  periodGroup: "Statistics period",
  tabList: "Statistics sections",
} as const;

export interface StatsHeaderView {
  /** What the numbers below cover: the period's calendar days, or the
   * tab's own note on its clock; none for a tab with neither. */
  range: string | null;
  /** The switcher disables on a tab that never reads it — disabled, not
   * hidden: hiding would jump the header layout. */
  periodIdle: boolean;
  /** The tab narrows to a workspace, so the scope chips show. */
  scoped: boolean;
  periods: { period: StatsPeriod; label: string; active: boolean }[];
  tabs: { id: StatsTab; label: string; active: boolean }[];
}

/** The period's calendar days, as the header names them. */
export function periodRange(period: StatsPeriod, now: number): string {
  if (period === "all") return "All time";
  if (period === 1) return `Today, ${formatLocalDay(now)}`;
  return `${formatLocalDay(statsSpans(period, now).current.from)} – ${formatLocalDay(now)}`;
}

export function statsHeaderView(tab: StatsTab, period: StatsPeriod, now: number): StatsHeaderView {
  return {
    range: periodless(tab) ? (TAB_SPECS[tab].note ?? null) : periodRange(period, now),
    periodIdle: periodless(tab),
    scoped: TAB_SPECS[tab].scoped === true,
    periods: USAGE_PERIODS.map((candidate) => ({
      period: candidate,
      label: PERIOD_LABELS[candidate],
      active: candidate === period,
    })),
    tabs: STATS_TAB_IDS.map((id) => ({ id, label: TAB_SPECS[id].label, active: id === tab })),
  };
}

/** What the dialog knows of the ledger as it renders a tab. */
export interface StatsHistoryState {
  ready: boolean;
  error: string | null;
  /** Whether the ledger holds any row at all. */
  hasRows: boolean;
  /** Rows in the selected period. */
  periodEvents: number;
}

/**
 * The tab panel's state. Two gates, both read off the tab's data policy,
 * never a hand-listed tab: a dead ledger (an error and no row at all)
 * blocks every ledger-backed tab — Limits renders from the independent
 * account snapshot regardless — and an empty period blocks only a tab whose
 * whole body is period-scoped. A partial history warns above whatever shows.
 */
export type StatsPanelView =
  | { kind: "loading"; text: string }
  | { kind: "unavailable"; text: string }
  | { kind: "empty"; warning: string | null; text: string }
  | { kind: "tab"; tab: StatsTab; warning: string | null };

export function statsPanelView(tab: StatsTab, history: StatsHistoryState): StatsPanelView {
  if (!history.ready) return { kind: "loading", text: "Loading usage history…" };
  const dead = history.error !== null && !history.hasRows;
  const spec = TAB_SPECS[tab];
  if (dead && spec.data !== "live-accounts") {
    return { kind: "unavailable", text: `Usage history is unavailable: ${history.error}` };
  }
  const warning = history.error !== null && !dead ? `Some history could not be loaded: ${history.error}` : null;
  if (spec.data === "period-ledger" && history.periodEvents === 0) {
    return { kind: "empty", warning, text: "No usage recorded in this period yet." };
  }
  return { kind: "tab", tab, warning };
}
