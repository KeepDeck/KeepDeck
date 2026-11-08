import { formatUtcDay } from "../../domain/usage";
import type { UsageStatsPeriod } from "../../domain/usage/history/query";
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
  intro: "Local token history and cost estimated from model prices across every CLI and workspace.",
  periodGroup: "Statistics period",
  tabList: "Statistics sections",
} as const;

export interface StatsHeaderView {
  /** The switcher disables on a tab that never reads it — disabled, not
   * hidden: hiding would jump the header layout. */
  periodIdle: boolean;
  periods: { period: UsageStatsPeriod; label: string; active: boolean }[];
  tabs: { id: StatsTab; label: string; active: boolean }[];
}

export function statsHeaderView(tab: StatsTab, period: UsageStatsPeriod): StatsHeaderView {
  return {
    periodIdle: periodless(tab),
    periods: USAGE_PERIODS.map((candidate) => ({
      period: candidate,
      label: PERIOD_LABELS[candidate],
      active: candidate === period,
    })),
    tabs: STATS_TAB_IDS.map((id) => ({ id, label: TAB_SPECS[id].label, active: id === tab })),
  };
}

/** The note under the Models list when the period reaches back past the
 * ledger's switch to booking per model, or null when it does not: rows on
 * either side of it name models differently, so one model can be listed
 * twice. */
export function perModelNote(
  perModelSince: number | null,
  firstOccurredAt: number | null,
): string | null {
  if (perModelSince === null || firstOccurredAt === null) return null;
  if (firstOccurredAt >= perModelSince) return null;
  return (
    `Since ${formatUtcDay(perModelSince, true)}, an agent that reports each model's own ` +
    "tokens is listed by model id, and a session's cost under the model it ran on. " +
    "Earlier usage keeps the model names shown at the time."
  );
}

/** What the dialog knows of the ledger as it renders a tab. */
export interface StatsHistoryState {
  ready: boolean;
  error: string | null;
  /** Whether the ledger holds any row at all. */
  hasRows: boolean;
  /** Rows in the selected period. */
  periodEvents: number;
  perModelSince: number | null;
  firstOccurredAt: number | null;
}

/**
 * The tab panel's state. Two gates, both read off the tab's data policy,
 * never a hand-listed tab: a dead ledger (an error and no row at all)
 * blocks every ledger-backed tab — Providers renders from the independent
 * account snapshot regardless — and an empty period blocks only a tab whose
 * whole body is period-scoped. A partial history warns above whatever shows.
 */
export type StatsPanelView =
  | { kind: "loading"; text: string }
  | { kind: "unavailable"; text: string }
  | { kind: "empty"; warning: string | null; text: string }
  | { kind: "tab"; tab: StatsTab; title: string; warning: string | null; note: string | null };

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
  return {
    kind: "tab",
    tab,
    title: spec.label,
    warning,
    // Rows on either side of the switch to booking per model name models
    // differently, so the Models list says so when the period reaches back
    // past it.
    note: tab === "models" ? perModelNote(history.perModelSince, history.firstOccurredAt) : null,
  };
}
