import {
  STATS_TAB_IDS,
  isStatsTab,
  type StatsTab,
} from "../../domain/usage/statsTabs";

/** The view side of the tab vocabulary: labels and switcher policy. The
 * ids and type live in the domain (statsTabs.ts) so deep-link producers
 * can speak them; the labels Record is exhaustive by construction — a new
 * tab fails to compile until it names itself. */

export { isStatsTab, type StatsTab };

const TAB_LABELS: Record<StatsTab, string> = {
  overview: "Overview",
  providers: "Providers",
  models: "Models",
  sessions: "Sessions",
  achievements: "Achievements",
};

export const STATS_TABS: readonly { id: StatsTab; label: string }[] =
  STATS_TAB_IDS.map((id) => ({ id, label: TAB_LABELS[id] }));

/** Tabs the period switcher cannot touch: providers run on the provider's
 * clock, achievements are all-time by definition. */
export const PERIODLESS_TABS: readonly StatsTab[] = ["providers", "achievements"];
