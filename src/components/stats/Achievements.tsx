import { useMemo } from "react";
import {
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
            {item.title}
            {item.repeat !== undefined ? ` ×${item.repeat}` : ""}
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
          the card only says which level it is. The rim comes first so its
          ground sits UNDER the cut and only its lit edge shows. */}
      <span className="stats__achievement-rim" aria-hidden />
      <span className="stats__achievement-dress" aria-hidden />
      {item.rarity === "legendary" && !locked ? <AchievementEmbers /> : null}
      <span className="stats__achievement-icon" aria-hidden>
        {item.icon}
      </span>
      <b>
        {item.title}
        {item.repeat !== undefined ? (
          <span className="stats__achievement-repeat"> ×{item.repeat}</span>
        ) : null}
      </b>
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
