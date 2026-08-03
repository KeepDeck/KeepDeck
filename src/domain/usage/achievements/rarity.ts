import type { AchievementMetric } from "./catalog";

/**
 * How rare a tier is — and, because the answer is COMPUTED, why.
 *
 * A hand-written level per tier would drift the moment a ladder gains one:
 * fifty judgement calls with nothing to argue against. So a tier's rarity
 * comes from how long it takes a REFERENCE user to reach it — one agent,
 * a few hours a day — and the only tunable numbers are one pace coefficient
 * per metric plus the four band edges.
 *
 * Two kinds of metric cannot be measured in time and say so explicitly:
 *
 * - COVERAGE (how many providers, models, workspaces): four providers are
 *   there from the first day or never; waiting does not bring them.
 * - PEAKS (the best day, the longest session): a peak is not accumulated,
 *   it is exceeded. Its rarity is the share of days or sessions that reach
 *   it, and the shares behind these were measured on a real ledger rather
 *   than guessed — with one deliberate correction, noted at the site.
 *
 * Those tiers carry an explicit `rarity` in the catalog; everything else is
 * derived here and is expected to stay derived.
 */

export type AchievementRarity =
  | "common"
  | "uncommon"
  | "rare"
  | "epic"
  | "legendary";

/** Ascending, so a comparison is an index comparison. */
export const RARITY_ORDER: readonly AchievementRarity[] = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
];

/**
 * What a steady single-agent user accumulates per day. Measured off a real
 * ledger and divided by four — one agent instead of four — so the scale is
 * grounded rather than invented.
 *
 * `spendUsd` is the exception and gets its own figure: money does not
 * transfer between users at all (a heavy Opus day and a modest Haiku day
 * differ fiftyfold, not fourfold), so scaling it with the others would make
 * one ladder either instant or unreachable for everybody.
 *
 * `streakDays` is a calendar count: a day is a day at any intensity.
 */
const REFERENCE_PACE: Record<AchievementMetric, number | null> = {
  tokens: 5_860_000,
  outputTokens: 677_000,
  cacheTokens: 203_000_000,
  sessions: 1.03,
  spendUsd: 20,
  streakDays: 1,
  // `null` = not accumulated over time. Spelled out rather than omitted, and
  // the record is TOTAL rather than Partial, so a new metric cannot compile
  // until its author has decided which kind it is. The alternative — an
  // optional table and a runtime throw — puts that decision on the app's
  // BOOT path (achievementCatalog runs inside runtime.start(), before the
  // first render), where the cost of forgetting is a blank window.
  dayTokens: null,
  daySessions: null,
  dayProviders: null,
  sessionTokens: null,
  sessionTurns: null,
  sessionHours: null,
  sessionSpendUsd: null,
  providers: null,
  models: null,
  workspaces: null,
};

/** The metrics rarity can time. Derived, so a test cannot drift from it. */
export const PACED_METRICS: readonly AchievementMetric[] = (
  Object.keys(REFERENCE_PACE) as AchievementMetric[]
).filter((metric) => REFERENCE_PACE[metric] !== null);

/** Band edges in reference-user DAYS. Legendary is a season's goal, not a
 * decade's — the endless top comes from re-earning it, never from a first
 * threshold nobody reaches. */
const BAND_DAYS: readonly number[] = [2, 7, 30, 90];

/** Which band a duration falls into. */
export function rarityForDays(days: number): AchievementRarity {
  for (let index = 0; index < BAND_DAYS.length; index += 1) {
    if (days < BAND_DAYS[index]) return RARITY_ORDER[index];
  }
  return "legendary";
}

/** How long the reference user needs for `threshold`, or null when the
 * metric is not accumulated over time (coverage and peaks). */
export function referenceDays(
  metric: AchievementMetric,
  threshold: number,
): number | null {
  const pace = REFERENCE_PACE[metric];
  return pace === null ? null : threshold / pace;
}

/** THE rarity of one tier. `declared` is the catalog's explicit level, which
 * only coverage and peak tiers carry; everything else is derived from pace,
 * and a metric that has neither is a catalog bug loud enough to see —
 * "common" would quietly dress a legendary badge as a starter one. */
export function achievementRarity(
  metric: AchievementMetric,
  threshold: number,
  declared?: AchievementRarity,
): AchievementRarity {
  if (declared) return declared;
  const days = referenceDays(metric, threshold);
  if (days === null) {
    throw new Error(
      `achievement metric "${metric}" has neither a reference pace nor a declared rarity`,
    );
  }
  return rarityForDays(days);
}

