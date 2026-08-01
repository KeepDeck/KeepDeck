import { useMemo } from "react";
import {
  achievementExact,
  achievementPercent,
  achievementProgress,
  achievementRequirement,
} from "../../domain/usage/achievements/captions";
import type { UsageAchievement } from "../../domain/usage/achievements/ladders";
import {
  earnedAchievements,
  lockedAchievements,
  nextAchievements,
  usageAchievementLadders,
} from "../../domain/usage/achievements/ladders";
import { formatUtcDay } from "../../domain/usage";
import type { UsageEventV2 } from "../../domain/usage/history/event";

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

function AchievementCard({
  item,
  future,
}: {
  item: UsageAchievement;
  future: boolean;
}) {
  const locked = item.achievedAt === null;
  return (
    <article
      className={`stats__achievement${
        locked ? " stats__achievement--locked" : ""
      }${future ? " stats__achievement--future" : ""}`}
    >
      <span className="stats__achievement-icon" aria-hidden>
        {item.icon}
      </span>
      <b>{item.title}</b>
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
      <span className="stats__achievement-tip" role="tooltip">
        <b>
          <span className="stats__achievement-tip-icon" aria-hidden>
            {item.icon}
          </span>{" "}
          {item.title}
        </b>
        <span>{achievementRequirement(item)}</span>
        <span>{achievementTipStatus(item)}</span>
      </span>
    </article>
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
