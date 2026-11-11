import { useState } from "react";
import type { SessionClaimKey } from "../domain/deck";
import type { StatsDimension } from "../domain/usage/stats/dimensions";
import type { StatsPeriod } from "../domain/usage/stats/period";
import type { BreakdownOrder } from "../presentation/stats/breakdownView";
import { DEFAULT_STATS_PERIOD } from "../presentation/stats/statsPeriods";

/** The Statistics view the reader set up: the period, the workspace the
 * numbers are narrowed to (null: every one), and how Breakdown groups and
 * orders them. */
export interface StatsView {
  period: StatsPeriod;
  workspace: string | null;
  /** The week Weekly reports, by its Monday's day ordinal; null follows the
   * calendar's current week. */
  week: number | null;
  dimension: StatsDimension;
  order: BreakdownOrder;
  selectPeriod(period: StatsPeriod): void;
  selectWorkspace(workspace: string | null): void;
  selectWeek(week: number | null): void;
  selectDimension(dimension: StatsDimension): void;
  selectOrder(order: BreakdownOrder): void;
}

/** What Statistics may ask the deck about a session: whether a pane holds
 * it, and bringing that pane in front. */
export interface StatsSessions {
  held(session: SessionClaimKey): boolean;
  reveal(session: SessionClaimKey): void;
}

/**
 * THE owner of the Statistics view state. Mounted at the controller beside
 * the modal router — not in the dialog — so closing and reopening the
 * dialog keeps what the reader picked; a restart starts from the defaults.
 * The router answers WHICH dialog is open and on which tab; this answers
 * what the statistics show.
 */
export function useStatsView(): StatsView {
  const [period, selectPeriod] = useState<StatsPeriod>(DEFAULT_STATS_PERIOD);
  const [workspace, selectWorkspace] = useState<string | null>(null);
  const [week, selectWeek] = useState<number | null>(null);
  const [dimension, selectDimension] = useState<StatsDimension>("workspace");
  const [order, selectOrder] = useState<BreakdownOrder>("cost");
  return {
    period, workspace, week, dimension, order, selectPeriod, selectWorkspace, selectWeek, selectDimension, selectOrder,
  };
}
