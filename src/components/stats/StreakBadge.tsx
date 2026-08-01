import { currentStreakDays, streakHeat } from "../../domain/usage/streak";
import type { UsageEventV2 } from "../../domain/usage/history";

/**
 * The live streak chip — Duolingo-style escalation: the longer the streak,
 * the louder the look. Tiers (from `streakHeat`): a plain count, a still
 * ember from 3 days, a flickering flame from 7, a glowing gradient number
 * from 30, and sparks rising off the chip from 100. All CSS; animations
 * bow out under prefers-reduced-motion.
 */
export function StreakBadge({
  events,
  now,
}: {
  events: readonly UsageEventV2[];
  now: number;
}) {
  const days = currentStreakDays(events, now);
  if (days === 0) return null;
  const heat = streakHeat(days);
  return (
    <span
      className={`stats__streak stats__streak--${heat}`}
      role="img"
      aria-label={`${days}-day streak`}
    >
      {heat !== "none" && (
        <span className="stats__streak-flame" aria-hidden>
          🔥
        </span>
      )}
      <b>{days}</b>
      <small>day{days === 1 ? "" : "s"}</small>
      {heat === "inferno" && (
        <>
          <i className="stats__streak-spark" aria-hidden />
          <i className="stats__streak-spark" aria-hidden />
          <i className="stats__streak-spark" aria-hidden />
        </>
      )}
    </span>
  );
}
