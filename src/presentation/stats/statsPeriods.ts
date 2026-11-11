import type { UsageStatsPeriod } from "../../domain/usage/history/query";

/** The period switcher's order and labels — exhaustive by construction: a
 * new UsageStatsPeriod member fails to compile until it names itself, so a
 * period can never exist that the switcher silently omits or that renders
 * as an empty string inside the Highlights sentence. */
export const USAGE_PERIODS: readonly UsageStatsPeriod[] = [1, 7, 30, 90, "all"];

export const PERIOD_LABELS: Record<UsageStatsPeriod, string> = {
  1: "24h",
  7: "7d",
  30: "30d",
  90: "90d",
  all: "All",
};

/** The period Statistics opens on until the reader picks another. */
export const DEFAULT_STATS_PERIOD: UsageStatsPeriod = 7;
