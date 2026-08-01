/**
 * The achievement vocabulary and the catalog itself — cumulative ladders
 * and one-off badges (a one-off is simply a single-tier ladder), recomputed
 * from the never-pruned ledger. Crossing instants are derivable on every
 * run, so nothing needs persisting: the ledger IS the trophy cabinet.
 *
 * Metric math lives in `./engine`, the dated batch views in `./ladders`,
 * per-metric phrasing in `./captions`.
 */

/** What a ladder counts. Determines both the metric and the captions. */
export type AchievementMetric =
  | "tokens"
  | "outputTokens"
  | "cacheTokens"
  | "sessions"
  | "spendUsd"
  | "dayTokens"
  | "daySessions"
  | "dayProviders"
  | "sessionTokens"
  | "sessionTurns"
  | "sessionHours"
  | "sessionSpendUsd"
  | "streakDays"
  | "providers"
  | "models"
  | "workspaces";

interface TierSpec {
  threshold: number;
  title: string;
  icon: string;
}

export const LADDERS: { metric: AchievementMetric; tiers: TierSpec[] }[] = [
  {
    metric: "tokens",
    tiers: [
      { threshold: 1e6, title: "First Million", icon: "🌱" },
      { threshold: 1e7, title: "Picking Up Steam", icon: "⚡" },
      { threshold: 1e8, title: "Heavy Rotation", icon: "🔥" },
      { threshold: 1e9, title: "Billion Club", icon: "💎" },
      { threshold: 1e10, title: "Token Tycoon", icon: "🏆" },
      { threshold: 1e11, title: "Galactic Scale", icon: "🌌" },
      { threshold: 1e12, title: "Trillionaire", icon: "🚀" },
    ],
  },
  {
    metric: "outputTokens",
    tiers: [
      { threshold: 1e6, title: "Prolific", icon: "✍️" },
      { threshold: 1e7, title: "Author", icon: "📝" },
      { threshold: 1e8, title: "Novelist", icon: "📚" },
      { threshold: 1e9, title: "Printing Press", icon: "🖨️" },
    ],
  },
  {
    metric: "cacheTokens",
    tiers: [
      { threshold: 1e8, title: "Warm Cache", icon: "💾" },
      { threshold: 1e9, title: "Total Recall", icon: "🧠" },
      { threshold: 1e10, title: "Cache Money", icon: "🏛️" },
    ],
  },
  {
    metric: "sessions",
    tiers: [
      { threshold: 1, title: "Hello, Agent", icon: "🤝" },
      { threshold: 10, title: "First Steps", icon: "🎯" },
      { threshold: 100, title: "Century", icon: "🏅" },
      { threshold: 1_000, title: "Workhorse", icon: "⚙️" },
      { threshold: 10_000, title: "Legend", icon: "🎖️" },
    ],
  },
  {
    metric: "spendUsd",
    tiers: [
      { threshold: 1, title: "First Dollar", icon: "🪙" },
      { threshold: 10, title: "Coffee Money", icon: "☕" },
      { threshold: 100, title: "Serious Business", icon: "💼" },
      { threshold: 1_000, title: "Deep Pockets", icon: "💰" },
      { threshold: 10_000, title: "High Roller", icon: "🎰" },
      { threshold: 100_000, title: "Venture Scale", icon: "🏦" },
    ],
  },
  {
    metric: "dayTokens",
    tiers: [
      { threshold: 1e6, title: "Warm Afternoon", icon: "☀️" },
      { threshold: 1e7, title: "Full Throttle", icon: "🏎️" },
      { threshold: 1e8, title: "Marathon", icon: "🏃" },
      { threshold: 1e9, title: "Supernova", icon: "💥" },
    ],
  },
  {
    metric: "daySessions",
    tiers: [
      { threshold: 5, title: "Juggler", icon: "🤹" },
      { threshold: 15, title: "Ringmaster", icon: "🎪" },
      { threshold: 40, title: "Hive Mind", icon: "🐝" },
    ],
  },
  {
    // One-off: every provider at the table on the same day.
    metric: "dayProviders",
    tiers: [{ threshold: 4, title: "Full House", icon: "🎴" }],
  },
  {
    metric: "sessionTokens",
    tiers: [
      { threshold: 1e7, title: "Deep Dive", icon: "🤿" },
      { threshold: 1e8, title: "Leviathan", icon: "🐋" },
      { threshold: 1e9, title: "White Whale", icon: "🦭" },
    ],
  },
  {
    // One-off: a hundred recorded turns inside one session.
    metric: "sessionTurns",
    tiers: [{ threshold: 100, title: "The Grind", icon: "🪨" }],
  },
  {
    // One-off: a session that ran for a working day.
    metric: "sessionHours",
    tiers: [{ threshold: 8, title: "Marathon Session", icon: "🌙" }],
  },
  {
    // One-off: three digits of provider-reported cost in one session.
    metric: "sessionSpendUsd",
    tiers: [{ threshold: 100, title: "All In", icon: "🃏" }],
  },
  {
    metric: "streakDays",
    tiers: [
      { threshold: 3, title: "Hat-Trick", icon: "🎩" },
      { threshold: 7, title: "Full Week", icon: "📅" },
      { threshold: 14, title: "Fortnight", icon: "🌗" },
      { threshold: 30, title: "Iron Month", icon: "🛡️" },
      { threshold: 100, title: "Perpetual Motion", icon: "🔄" },
    ],
  },
  {
    metric: "providers",
    tiers: [
      { threshold: 2, title: "Two-Timer", icon: "🎭" },
      { threshold: 3, title: "Polyglot", icon: "🌐" },
      { threshold: 4, title: "Collector", icon: "🧩" },
    ],
  },
  {
    metric: "models",
    tiers: [
      { threshold: 3, title: "Curious", icon: "🔍" },
      { threshold: 10, title: "Explorer", icon: "🧭" },
      { threshold: 25, title: "Cartographer", icon: "🗺️" },
    ],
  },
  {
    metric: "workspaces",
    tiers: [
      { threshold: 2, title: "Side Project", icon: "🗂️" },
      { threshold: 5, title: "Portfolio", icon: "🏗️" },
      { threshold: 10, title: "Empire Builder", icon: "🌆" },
    ],
  },
];

/** THE earned predicate: how many of a ladder's ascending tiers the
 * current value meets — the earned prefix. Both consumers (the engine's
 * eligibility set and the gallery's crossing cursor) answer through here,
 * and so does its one assumption: every metric is monotonically
 * non-decreasing, so earned tiers never un-earn. A future non-monotonic
 * metric (a CURRENT streak, say) must change this function, not fork it. */
export function earnedTierCount(
  value: number,
  tiers: readonly { threshold: number }[],
): number {
  let count = 0;
  while (count < tiers.length && value >= tiers[count].threshold) count += 1;
  return count;
}

/** THE tier-id format. Persisted in the congratulated set on disk, so it is
 * a wire format: changing it un-congratulates every past award. */
export function achievementId(
  metric: AchievementMetric,
  threshold: number,
): string {
  return `${metric}-${threshold}`;
}

/** One catalog entry, flat — what the notifier needs to announce a tier. */
export interface AchievementCatalogEntry {
  id: string;
  metric: AchievementMetric;
  threshold: number;
  title: string;
  icon: string;
}

/** The flat catalog in ladder order (each ladder's tiers ascending). */
export function achievementCatalog(): AchievementCatalogEntry[] {
  return LADDERS.flatMap((ladder) =>
    ladder.tiers.map((tier) => ({
      id: achievementId(ladder.metric, tier.threshold),
      metric: ladder.metric,
      threshold: tier.threshold,
      title: tier.title,
      icon: tier.icon,
    })),
  );
}
