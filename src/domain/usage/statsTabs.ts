/**
 * The Statistics dialog's tab vocabulary — domain-owned so every producer
 * of a deep link speaks the TYPE, not a bare string: the notification
 * source, the app-layer owner and the dialog all share it, and renaming a
 * tab fails to compile at each of them instead of silently landing every
 * deep link on Overview.
 */

export type StatsTab =
  | "overview"
  | "providers"
  | "models"
  | "sessions"
  | "achievements";

export const STATS_TAB_IDS: readonly StatsTab[] = [
  "overview",
  "providers",
  "models",
  "sessions",
  "achievements",
];

export function isStatsTab(value: unknown): value is StatsTab {
  return (
    typeof value === "string" &&
    (STATS_TAB_IDS as readonly string[]).includes(value)
  );
}
