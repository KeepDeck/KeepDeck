import {
  achievementDisplayTitle,
  achievementExact,
  achievementPercent,
  achievementProgress,
  achievementRequirement,
} from "../../domain/usage/achievements/captions";
import {
  earnedAchievements,
  lockedAchievements,
  nextAchievements,
  type UsageAchievement,
  type UsageAchievementLadder,
} from "../../domain/usage/achievements/ladders";
import type { AchievementRarity } from "../../domain/usage/achievements/rarity";
import { formatUtcDay } from "../../domain/usage";

/**
 * The Achievements tab as the component maps it: which sections there are,
 * in which order and under which words, and what each badge card says and
 * wears. The component renders this and decides nothing.
 */

/** The level in words. The card says it in colour, so the words are for
 * the tip and for a reader who cannot separate those hues. */
const RARITY_LABELS: Record<AchievementRarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

/**
 * Which badges give off light. The stylesheet decides what every OTHER level
 * wears, but this one cannot: forty canvases would mount whether or not CSS
 * chose to paint them, and that cost is real. So the predicate lives here —
 * once, named — rather than being spelled out at the mount site while the
 * stylesheet spells the same thing four more times in its own language.
 */
export function wearsEmbers(item: UsageAchievement): boolean {
  return item.rarity === "legendary" && item.achievedAt !== null;
}

/**
 * A stable fraction in [0, 1) from a badge's id — the one hash behind both
 * of the rim's per-card numbers. Two SEEDS rather than two derivations of a
 * single draw, so a badge's pace says nothing about where its light starts.
 *
 * DERIVED, never rolled. A random draw would be a fresh number on every
 * re-render: the light would jump to another point of the border each time
 * the ledger moved, and the pace would change under it.
 *
 * FNV-1a with murmur3's finalizer on the end. FNV-1a's avalanche is weak and
 * these ids differ only in their tail (`tokens-25000000` beside
 * `tokens-100000000`), so without the mixing step a whole ladder's badges
 * come out at nearly the same number — measured on the live catalog, the
 * closest pair of the 25 runner-rarity badges sat 0.02% of the range apart
 * before the finalizer and 0.6% after.
 */
function idUnit(id: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  // `>>> 0` before the divide: the mixing leaves a SIGNED 32-bit value, and
  // half of all hashes have their top bit set — those would come out
  // negative, i.e. outside the range every caller here is promised.
  return (hash >>> 0) / 0x1_0000_0000;
}

/** FNV-1a's own offset basis, and any other 32-bit start beside it. The
 * second value means nothing except that it is a different one: two seeds
 * are two independent streams out of the same hash. */
const DRIFT_SEED = 0x811c9dc5;
const PHASE_SEED = 0x2f1e5a3b;

/** How far a badge's pace may sit from its level's — a fraction either way.
 * Wide enough that a row of cards keeps separating, narrow enough that none
 * of them reads as the broken slow one. */
const RIM_DRIFT = 0.05;

/**
 * How fast THIS badge runs its edge, as a multiple of its level's period.
 * The stylesheet gives epic one duration and legendary another; without a
 * per-card multiple two badges of one level, once aligned, stay aligned
 * forever.
 */
export function rimDrift(id: string): number {
  return 1 + (idUnit(id, DRIFT_SEED) * 2 - 1) * RIM_DRIFT;
}

/**
 * WHERE on the border this badge's light already is when the gallery opens,
 * as a fraction of one turn.
 *
 * The pace alone cannot do this job. Every card's animation begins the
 * moment the gallery mounts, so a row of badges leaves the gate together
 * and a spread of a few percent takes tens of seconds to become visible —
 * which is exactly how it looked: the same light drawn five times. A
 * starting offset separates them in the first frame, and the pace is what
 * keeps them from ever meeting again.
 */
export function rimPhase(id: string): number {
  return idUnit(id, PHASE_SEED);
}

/** What a card says under its requirement. An earned badge says when; a
 * badge being worked toward shows how far; a tier still behind another says
 * nothing — it is visible, but inert. */
export type AchievementCardStatus =
  | { kind: "earned"; text: string }
  | { kind: "progress"; percent: number; text: string }
  | { kind: "none" };

export interface AchievementCardView {
  id: string;
  icon: string;
  title: string;
  rarity: AchievementRarity;
  /** The level in words: the tip's, and the screen reader's on the card. */
  rarityLabel: string;
  requirement: string;
  /** Not earned yet. */
  locked: boolean;
  /** A tier behind one not earned yet. */
  future: boolean;
  embers: boolean;
  /** How far THIS badge's edge runs off its level's pace, and where on the
   * border it starts — the two things the stylesheet cannot know. */
  rim: { drift: number; phase: number };
  status: AchievementCardStatus;
  /** The tip's last line: when it was earned, or the exact numbers. */
  tipStatus: string;
}

/** One home for the earned date — the card and its own tip must never
 * disagree on how a trophy's date reads. */
function earnedDate(achievedAt: number): string {
  return formatUtcDay(achievedAt, true);
}

export function achievementCardView(item: UsageAchievement, future: boolean): AchievementCardView {
  const earned = item.achievedAt;
  return {
    id: item.id,
    icon: item.icon,
    title: achievementDisplayTitle(item),
    rarity: item.rarity,
    rarityLabel: RARITY_LABELS[item.rarity],
    requirement: achievementRequirement(item),
    locked: earned === null,
    future,
    embers: wearsEmbers(item),
    rim: { drift: rimDrift(item.id), phase: rimPhase(item.id) },
    status:
      earned !== null
        ? { kind: "earned", text: `earned ${earnedDate(earned)}` }
        : future
          ? { kind: "none" }
          : { kind: "progress", percent: achievementPercent(item), text: achievementProgress(item) },
    // Exact numbers, not the card's compact abbreviations; the per-metric
    // formatting lives with the metric specs.
    tipStatus: earned !== null ? `Earned ${earnedDate(earned)}` : achievementExact(item),
  };
}

export interface AchievementSectionView {
  title: string;
  cards: AchievementCardView[];
}

/** The tab in three sections: the goals being walked toward (one per
 * ladder, with progress) first — they are the pull; the trophy case of
 * earned badges (freshest first); and the locked tail — every tier still
 * ahead, visible but inert until its predecessor is won. A section with
 * nothing in it is left out. */
export function achievementSections(ladders: readonly UsageAchievementLadder[]): AchievementSectionView[] {
  const sections: [string, UsageAchievement[], boolean][] = [
    ["In progress", nextAchievements(ladders), false],
    ["Earned", earnedAchievements(ladders), false],
    ["Locked", lockedAchievements(ladders), true],
  ];
  return sections
    .filter(([, items]) => items.length > 0)
    .map(([title, items, future]) => ({ title, cards: items.map((item) => achievementCardView(item, future)) }));
}
