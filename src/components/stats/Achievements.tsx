import { useMemo, type CSSProperties } from "react";
import {
  achievementDisplayTitle,
  achievementExact,
  achievementPercent,
  achievementProgress,
  achievementRequirement,
} from "../../domain/usage/achievements/captions";
import type { UsageAchievement } from "../../domain/usage/achievements/ladders";
import type { AchievementRarity } from "../../domain/usage/achievements/rarity";
import {
  earnedAchievements,
  lockedAchievements,
  nextAchievements,
  usageAchievementLadders,
} from "../../domain/usage/achievements/ladders";
import { formatUtcDay } from "../../domain/usage";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import { Tooltip } from "../../ui/Tooltip";
import { AchievementEmbers } from "./AchievementEmbers";

/** The achievements tab in three sections: the goals being walked toward
 * (one per ladder, with progress) first — they are the pull; the trophy
 * case of earned badges (freshest first); and the locked tail — every tier
 * still ahead, visible but inert until its predecessor is won. */
export function Achievements({ events }: { events: readonly UsageEventV2[] }) {
  const ladders = useMemo(() => usageAchievementLadders(events), [events]);
  const inProgress = nextAchievements(ladders);
  const earned = earnedAchievements(ladders);
  const locked = lockedAchievements(ladders);
  return (
    <>
      <AchievementSection title="In progress" items={inProgress} />
      <AchievementSection title="Earned" items={earned} />
      <AchievementSection title="Locked" items={locked} future />
    </>
  );
}

function AchievementSection({
  title,
  items,
  future,
}: {
  title: string;
  items: UsageAchievement[];
  future?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className="stats__section">
      <h3>{title}</h3>
      <div className="stats__achievements">
        {items.map((item) => (
          <AchievementCard key={item.id} item={item} future={future === true} />
        ))}
      </div>
    </section>
  );
}

/** The hover-intent pause before a card's detail tip shows — a grid
 * swept by the cursor must not strobe forty tips. */
const TIP_DELAY_MS = 450;

/** The level in words, for the tip. Deliberately absent from the CARD: the
 * dress already says it, and a fifth line of text on fifty badges is noise. */
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

function AchievementCard({
  item,
  future,
}: {
  item: UsageAchievement;
  future: boolean;
}) {
  const locked = item.achievedAt === null;
  // The card IS the tip's anchor: the shared Tooltip portals the detail
  // layer, so the scroller can no longer clip it — the flip-above
  // measurement and the paint-order lift died with the in-flow tip.
  return (
    <Tooltip
      className={`stats__achievement stats__achievement--${item.rarity}${
        locked ? " stats__achievement--locked" : ""
      }${future ? " stats__achievement--future" : ""}`}
      delayMs={TIP_DELAY_MS}
      tip={
        <span
          className={`stats__achievement-tip${
            locked ? " stats__achievement-tip--locked" : ""
          }`}
        >
          <b>
            <span className="stats__achievement-tip-icon" aria-hidden>
              {item.icon}
            </span>{" "}
            {achievementDisplayTitle(item)}
          </b>
          {/* The card says the level in colour alone; the tip says it in
              words, which is also the version a reader who cannot separate
              those hues gets. */}
          <span>{RARITY_LABELS[item.rarity]}</span>
          <span>{achievementRequirement(item)}</span>
          <span>{achievementTipStatus(item)}</span>
        </span>
      }
    >
      {/* The rarity's own layers — a running edge, a cut ground, a turning
          spectrum. Which levels light which is decided in the stylesheet;
          the card says which level it is, and — the two things a stylesheet
          cannot know, because they are per-badge — how far THIS badge's edge
          runs off its level's pace and where on the border it starts. Both
          ride on every rim, including the levels that show no runner at all:
          the question of who has one has a single home, and it is not here.
          The rim comes first so its ground sits UNDER the cut and only its
          lit edge shows. */}
      <span
        className="stats__achievement-rim stats__achievement-layer"
        style={
          {
            "--rim-drift": rimDrift(item.id),
            "--rim-phase": rimPhase(item.id),
          } as CSSProperties
        }
        aria-hidden
      />
      <span className="stats__achievement-dress stats__achievement-layer" aria-hidden />
      {wearsEmbers(item) ? <AchievementEmbers /> : null}
      <span className="stats__achievement-icon" aria-hidden>
        {item.icon}
      </span>
      <b>{achievementDisplayTitle(item)}</b>
      {/* The card says the level in colour, and the hover tip says it in
          words — but a tip opens on hover alone, so without this the level
          is unavailable to anyone not using a mouse, and to anyone who
          cannot separate those hues. Hidden rather than shown because a
          fifth line of text on fifty badges is noise. */}
      <span className="kd-sr">{RARITY_LABELS[item.rarity]}</span>
      <small>{achievementRequirement(item)}</small>
      {!locked ? (
        <small className="stats__achievement-earned">
          earned {earnedDate(item)}
        </small>
      ) : future ? null : (
        <>
          <span className="stats__achievement-progress" aria-hidden>
            <i style={{ width: `${achievementPercent(item)}%` }} />
          </span>
          <small>{achievementProgress(item)}</small>
        </>
      )}
    </Tooltip>
  );
}

/** One home for the earned-date rendering — the card and its own tooltip
 * must never disagree on how a trophy's date reads. */
function earnedDate(item: UsageAchievement): string {
  return formatUtcDay(item.achievedAt ?? 0, true);
}

/** The hover tooltip's status line — exact numbers, not the card's compact
 * abbreviations. The per-metric formatting lives with the metric specs. */
function achievementTipStatus(item: UsageAchievement): string {
  if (item.achievedAt !== null) {
    return `Earned ${earnedDate(item)}`;
  }
  return achievementExact(item);
}
