/**
 * The achievement vocabulary and the catalog itself — cumulative ladders
 * and one-off badges (a one-off is simply a single-tier ladder), recomputed
 * from the never-pruned ledger. Crossing instants are derivable on every
 * run, so nothing needs persisting: the ledger IS the trophy cabinet.
 *
 * Metric math lives in `./engine`, the dated batch views in `./ladders`,
 * per-metric phrasing in `./captions`, and how rare a tier is in `./rarity`.
 */
import { achievementRarity, type AchievementRarity } from "./rarity";

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
  /** Only coverage and peak tiers state a level; the rest is derived from
   * the reference pace — see [`achievementRarity`]. */
  rarity?: AchievementRarity;
  /** Which time this legendary has been won. A ladder does not stop at its
   * first legendary tier: the top re-earns at each further ×10, so the
   * heaviest user still has somewhere to climb without inventing a sixth
   * level nobody else would ever see. */
  repeat?: number;
}

/**
 * Accumulating ladders are calibrated so their five steps land one per
 * rarity band at the reference pace; `rarity.test.ts` holds them to it, so
 * a threshold cannot be nudged without the band moving with it.
 */
export const LADDERS: { metric: AchievementMetric; tiers: TierSpec[] }[] = [
  {
    metric: "tokens",
    tiers: [
      { threshold: 1e6, title: "First Million", icon: "🌱" },
      { threshold: 2.5e7, title: "Picking Up Steam", icon: "⚡" },
      { threshold: 1.5e8, title: "Heavy Rotation", icon: "🔥" },
      { threshold: 5e8, title: "Billion Club", icon: "💎" },
      { threshold: 2e9, title: "Token Tycoon", icon: "🏆" },
      { threshold: 2e10, title: "Token Tycoon", icon: "🏆", repeat: 2 },
      { threshold: 2e11, title: "Token Tycoon", icon: "🏆", repeat: 3 },
    ],
  },
  {
    metric: "outputTokens",
    tiers: [
      { threshold: 1e5, title: "Prolific", icon: "✍️" },
      { threshold: 3e6, title: "Author", icon: "📝" },
      { threshold: 1.5e7, title: "Novelist", icon: "📚" },
      { threshold: 6e7, title: "Printing Press", icon: "🖨️" },
      { threshold: 2e8, title: "Library", icon: "📖" },
      { threshold: 2e9, title: "Library", icon: "📖", repeat: 2 },
    ],
  },
  {
    metric: "cacheTokens",
    tiers: [
      { threshold: 1e8, title: "Warm Cache", icon: "💾" },
      { threshold: 1e9, title: "Total Recall", icon: "🧠" },
      { threshold: 5e9, title: "Cache Money", icon: "🏛️" },
      { threshold: 1.5e10, title: "Deep Storage", icon: "🗄️" },
      { threshold: 6e10, title: "Perfect Memory", icon: "🔮" },
      { threshold: 6e11, title: "Perfect Memory", icon: "🔮", repeat: 2 },
    ],
  },
  {
    metric: "sessions",
    tiers: [
      { threshold: 1, title: "Hello, Agent", icon: "🤝" },
      { threshold: 5, title: "First Steps", icon: "🎯" },
      { threshold: 25, title: "Century", icon: "🏅" },
      { threshold: 80, title: "Workhorse", icon: "⚙️" },
      { threshold: 250, title: "Legend", icon: "🎖️" },
      { threshold: 2_500, title: "Legend", icon: "🎖️", repeat: 2 },
    ],
  },
  {
    metric: "spendUsd",
    tiers: [
      { threshold: 10, title: "First Dollar", icon: "🪙" },
      { threshold: 100, title: "Coffee Money", icon: "☕" },
      { threshold: 500, title: "Serious Business", icon: "💼" },
      { threshold: 1_500, title: "Deep Pockets", icon: "💰" },
      { threshold: 5_000, title: "High Roller", icon: "🎰" },
      { threshold: 50_000, title: "High Roller", icon: "🎰", repeat: 2 },
    ],
  },
  {
    // PEAK: what one day held. Shares below are what a real ledger showed,
    // which is a heavy user's curve — a calmer one reaches these far less
    // often, so the levels lean rarer than that curve alone would suggest.
    metric: "dayTokens",
    tiers: [
      { threshold: 1e6, title: "Warm Afternoon", icon: "☀️", rarity: "common" },
      { threshold: 1e7, title: "Full Throttle", icon: "🏎️", rarity: "uncommon" },
      { threshold: 1e8, title: "Marathon", icon: "🏃", rarity: "epic" },
      { threshold: 1e9, title: "Supernova", icon: "💥", rarity: "legendary" },
    ],
  },
  {
    metric: "daySessions",
    tiers: [
      { threshold: 5, title: "Juggler", icon: "🤹", rarity: "common" },
      { threshold: 15, title: "Ringmaster", icon: "🎪", rarity: "epic" },
      { threshold: 40, title: "Hive Mind", icon: "🐝", rarity: "legendary" },
    ],
  },
  {
    // One-off: every provider at the table on the same day — 8% of days.
    metric: "dayProviders",
    tiers: [{ threshold: 4, title: "Full House", icon: "🎴", rarity: "rare" }],
  },
  {
    metric: "sessionTokens",
    tiers: [
      { threshold: 1e7, title: "Deep Dive", icon: "🤿", rarity: "rare" },
      { threshold: 1e8, title: "Leviathan", icon: "🐋", rarity: "epic" },
      { threshold: 1e9, title: "White Whale", icon: "🦭", rarity: "legendary" },
    ],
  },
  {
    // One-off: a hundred recorded turns inside one session.
    metric: "sessionTurns",
    tiers: [{ threshold: 100, title: "The Grind", icon: "🪨", rarity: "uncommon" }],
  },
  {
    // One-off: a session that ran for a working day. The measured share said
    // "common", but it was measured on a ledger whose MEDIAN session runs
    // eleven hours — an outlier, not a yardstick. Eight hours at a keyboard
    // is rare for anyone else, and the level says so.
    metric: "sessionHours",
    tiers: [{ threshold: 8, title: "Marathon Session", icon: "🌙", rarity: "rare" }],
  },
  {
    // One-off: three digits of provider-reported cost in one session. Same
    // correction as above, for the same reason.
    metric: "sessionSpendUsd",
    tiers: [{ threshold: 100, title: "All In", icon: "🃏", rarity: "rare" }],
  },
  {
    metric: "streakDays",
    tiers: [
      { threshold: 1, title: "Day One", icon: "🌅" },
      { threshold: 3, title: "Hat-Trick", icon: "🎩" },
      { threshold: 14, title: "Fortnight", icon: "🌗" },
      { threshold: 45, title: "Iron Month", icon: "🛡️" },
      { threshold: 90, title: "Perpetual Motion", icon: "🔄" },
    ],
  },
  {
    // COVERAGE: there are only four providers to find, so this ladder ends
    // where the world does rather than pretending at a legendary step.
    metric: "providers",
    tiers: [
      { threshold: 2, title: "Two-Timer", icon: "🎭", rarity: "common" },
      { threshold: 3, title: "Polyglot", icon: "🌐", rarity: "uncommon" },
      { threshold: 4, title: "Collector", icon: "🧩", rarity: "rare" },
    ],
  },
  {
    metric: "models",
    tiers: [
      { threshold: 3, title: "Curious", icon: "🔍", rarity: "common" },
      { threshold: 10, title: "Explorer", icon: "🧭", rarity: "uncommon" },
      { threshold: 25, title: "Cartographer", icon: "🗺️", rarity: "epic" },
    ],
  },
  {
    metric: "workspaces",
    tiers: [
      { threshold: 2, title: "Side Project", icon: "🗂️", rarity: "common" },
      { threshold: 5, title: "Portfolio", icon: "🏗️", rarity: "uncommon" },
      { threshold: 10, title: "Empire Builder", icon: "🌆", rarity: "rare" },
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
  rarity: AchievementRarity;
  repeat?: number;
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
      rarity: achievementRarity(ladder.metric, tier.threshold, tier.rarity),
      ...(tier.repeat !== undefined ? { repeat: tier.repeat } : {}),
    })),
  );
}

/**
 * Tiers whose threshold MOVED when the ladders were recalibrated, old id to
 * new. The id carries the threshold and is persisted in the congratulated
 * set, so without this every moved tier would look brand new on the first
 * launch after the update and the user would be congratulated two dozen
 * times for things they earned weeks ago.
 *
 * Retroactive announcement stays the contract for genuinely NEW tiers; this
 * only carries an old award forward to the step that replaced it.
 */
export const RECALIBRATED_IDS: ReadonlyMap<string, string> = new Map([
  ["tokens-10000000", "tokens-25000000"],
  ["tokens-100000000", "tokens-150000000"],
  ["tokens-1000000000", "tokens-500000000"],
  ["tokens-10000000000", "tokens-2000000000"],
  ["tokens-100000000000", "tokens-20000000000"],
  ["tokens-1000000000000", "tokens-200000000000"],
  ["outputTokens-1000000", "outputTokens-100000"],
  ["outputTokens-10000000", "outputTokens-3000000"],
  ["outputTokens-100000000", "outputTokens-15000000"],
  ["outputTokens-1000000000", "outputTokens-60000000"],
  ["cacheTokens-10000000000", "cacheTokens-5000000000"],
  ["sessions-10", "sessions-5"],
  ["sessions-100", "sessions-25"],
  ["sessions-1000", "sessions-80"],
  ["sessions-10000", "sessions-250"],
  ["spendUsd-1", "spendUsd-10"],
  ["spendUsd-10", "spendUsd-100"],
  ["spendUsd-100", "spendUsd-500"],
  ["spendUsd-1000", "spendUsd-1500"],
  ["spendUsd-10000", "spendUsd-5000"],
  ["spendUsd-100000", "spendUsd-50000"],
  ["streakDays-7", "streakDays-1"],
  ["streakDays-30", "streakDays-45"],
  ["streakDays-100", "streakDays-90"],
]);

/** Carry a persisted congratulated set across the recalibration. Unknown ids
 * are kept as they are: a set from a NEWER build must survive a downgrade
 * intact, and an id this build cannot place is not evidence it is stale. */
export function migrateCongratulated(ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) out.add(RECALIBRATED_IDS.get(id) ?? id);
  return out;
}
