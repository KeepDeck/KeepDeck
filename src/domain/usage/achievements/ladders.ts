import type { UsageRow } from "../history/event";
import {
  catalogEntry,
  earnedTierCount,
  LADDERS,
  type AchievementCatalogEntry,
  type AchievementMetric,
} from "./catalog";
import { createAchievementEngine } from "./engine";

/**
 * The dated batch views of the gallery. Presentation contract (the user's
 * rule): a ladder exposes its earned tiers, ONE in-progress goal (the first
 * locked tier), and the rest as visibly locked future tiers —
 * [`earnedAchievements`], [`nextAchievements`] and [`lockedAchievements`]
 * are those three views.
 */

/** A catalog tier carrying its ledger-derived state. It EXTENDS the catalog
 * entry rather than restating it: the dated fields are what this module
 * adds, and only those belong to it. */
export interface UsageAchievement extends AchievementCatalogEntry {
  /** Won: the ledger crosses it, or it was awarded before and is kept. */
  earned: boolean;
  /** The ledger instant that crossed the threshold; null while locked, and
   * for an award kept from before that the ledger no longer crosses. */
  achievedAt: number | null;
  /** The metric's current all-time value. */
  progress: number;
}

export interface UsageAchievementLadder {
  metric: AchievementMetric;
  /** Ascending; earned prefix, then locked. */
  tiers: UsageAchievement[];
}

/** No awards kept from before. */
export const NO_KEPT: ReadonlySet<string> = new Set();

/** All ladders with crossing dates and current progress, in catalog order.
 * The batch view: sorts chronologically so each crossing is dated at the
 * exact event that crossed it — the ONLY place chronology matters.
 *
 * `kept` is what was already awarded: an award is never taken back (user
 * decision, 2026-11-11), so a tier in it stays earned even where a metric
 * now derives lower — the per-day ones moved to the reader's calendar, and
 * a day the UTC bucket merged can split. */
export function usageAchievementLadders(
  events: readonly UsageRow[],
  kept: ReadonlySet<string> = NO_KEPT,
): UsageAchievementLadder[] {
  const ordered = [...events].sort((a, b) => a.occurredAt - b.occurredAt);
  const engine = createAchievementEngine();
  const next = LADDERS.map(() => 0);
  const crossings = LADDERS.map(() => new Map<number, number>());

  for (const event of ordered) {
    engine.ingest(event);
    LADDERS.forEach((ladder, index) => {
      const earned = earnedTierCount(engine.value(ladder.metric), ladder.tiers);
      while (next[index] < earned) {
        crossings[index].set(
          ladder.tiers[next[index]].threshold,
          event.occurredAt,
        );
        next[index] += 1;
      }
    });
  }

  return LADDERS.map((ladder, index) => ({
    metric: ladder.metric,
    tiers: ladder.tiers.map((tier) => {
      const entry = catalogEntry(ladder.metric, tier);
      const achievedAt = crossings[index].get(tier.threshold) ?? null;
      return { ...entry, earned: achievedAt !== null || kept.has(entry.id), achievedAt, progress: engine.value(ladder.metric) };
    }),
  }));
}

/** Every earned tier across ladders, freshest first (the Steam-style
 * trophy-case order) — also the notifier's diff surface. */
export function earnedAchievements(
  ladders: readonly UsageAchievementLadder[],
): UsageAchievement[] {
  return ladders
    .flatMap((ladder) => ladder.tiers.filter((tier) => tier.earned))
    .sort((left, right) => (right.achievedAt ?? 0) - (left.achievedAt ?? 0));
}

/** The in-progress view, one goal per ladder: the FIRST locked tier — the
 * one the user is actively walking toward. A completed ladder contributes
 * nothing. */
export function nextAchievements(
  ladders: readonly UsageAchievementLadder[],
): UsageAchievement[] {
  return ladders.flatMap((ladder) => {
    const next = ladder.tiers.find((tier) => !tier.earned);
    return next ? [next] : [];
  });
}

/** The locked tail: every tier BEYOND each ladder's in-progress goal —
 * earnable in theory, reachable only after the previous tier is won. */
export function lockedAchievements(
  ladders: readonly UsageAchievementLadder[],
): UsageAchievement[] {
  return ladders.flatMap((ladder) => {
    const first = ladder.tiers.findIndex((tier) => !tier.earned);
    return first === -1 ? [] : ladder.tiers.slice(first + 1);
  });
}
