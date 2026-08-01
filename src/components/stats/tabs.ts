/** The Stats dialog's tab facts — shared with the app-layer owner of the
 * open/close/tab sequence so deep links carry a validated tab, not a bare
 * string. */

export type StatsTab =
  | "overview"
  | "providers"
  | "models"
  | "sessions"
  | "achievements";

export const STATS_TABS: readonly { id: StatsTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "sessions", label: "Sessions" },
  { id: "achievements", label: "Achievements" },
];

/** Tabs the period switcher cannot touch: providers run on the provider's
 * clock, achievements are all-time by definition. */
export const PERIODLESS_TABS: readonly StatsTab[] = ["providers", "achievements"];

export function isStatsTab(value: string | undefined | null): value is StatsTab {
  return STATS_TABS.some((candidate) => candidate.id === value);
}
