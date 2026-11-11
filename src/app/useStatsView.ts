import { useState } from "react";
import type { UsageStatsPeriod } from "../domain/usage/history/query";
import { DEFAULT_STATS_PERIOD } from "../presentation/stats/statsPeriods";

/** The Statistics view the reader set up. */
export interface StatsView {
  period: UsageStatsPeriod;
  selectPeriod(period: UsageStatsPeriod): void;
}

/**
 * THE owner of the Statistics view state. Mounted at the controller beside
 * the modal router — not in the dialog — so closing and reopening the
 * dialog keeps what the reader picked; a restart starts from the defaults.
 * The router answers WHICH dialog is open and on which tab; this answers
 * what the statistics show.
 */
export function useStatsView(): StatsView {
  const [period, selectPeriod] = useState<UsageStatsPeriod>(DEFAULT_STATS_PERIOD);
  return { period, selectPeriod };
}
