/**
 * The Statistics dialog's tab vocabulary — domain-owned so every producer
 * of a deep link speaks the TYPE, not a bare string: the notification
 * source, the app-layer owner and the dialog all share it, and renaming a
 * tab fails to compile at each of them instead of silently landing every
 * deep link on Overview.
 */

/** THE tab id list; the type is derived from it, so the two can never
 * drift — a new tab is added here once, and the view's TAB_SPECS plus the
 * switchboard's exhaustive body switch are compiler-demanded to follow. */
export const STATS_TAB_IDS = [
  "overview",
  "providers",
  "models",
  "sessions",
  "achievements",
] as const;

export type StatsTab = (typeof STATS_TAB_IDS)[number];

export function isStatsTab(value: unknown): value is StatsTab {
  return (
    typeof value === "string" &&
    (STATS_TAB_IDS as readonly string[]).includes(value)
  );
}
