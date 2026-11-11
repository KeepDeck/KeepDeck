import type { StatsPeriod } from "../../domain/usage/stats/period";

/** The period switcher's order and labels — exhaustive by construction: a
 * new StatsPeriod member fails to compile until it names itself, so a
 * period can never exist that the switcher silently omits. Calendar
 * periods: "Today" and "N days", never "24h". */
export const USAGE_PERIODS: readonly StatsPeriod[] = [1, 7, 30, 90, "all"];

export const PERIOD_LABELS: Record<StatsPeriod, string> = {
  1: "Today",
  7: "7 days",
  30: "30 days",
  90: "90 days",
  all: "All",
};

/** The period Statistics opens on until the reader picks another. */
export const DEFAULT_STATS_PERIOD: StatsPeriod = 7;
