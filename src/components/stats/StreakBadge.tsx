import { useId, useMemo } from "react";
import { useUsageHistorySnapshot } from "../../app/useUsageHistorySnapshot";
import {
  currentStreakDays,
  streakHeat,
  type StreakHeat,
} from "../../domain/usage/streak";
import { useWallClock } from "../../ui/useWallClock";

/**
 * The live streak chip — the longer the streak, the louder the look. Each
 * heat tier carries its own mark (from `streakHeat`): nothing at 1–2 days,
 * a breathing coal from 3, a small swaying flame with a flickering core
 * from 7, a bigger flame and a molten number from 30, and a white-hot core
 * with rising sparks and a shimmering number from 100. Hand-drawn SVG, all
 * CSS animation; everything bows out under prefers-reduced-motion.
 *
 * ACCEPTED PROVISIONALLY (user, 2026-08-01): the visual treatment is "good
 * enough for now" — a dedicated design pass is planned separately.
 *
 * Self-sufficient (reads the ledger itself) so it can sit in the dialog's
 * footer corner, outside the tab body.
 */
export function StreakBadge() {
  const history = useUsageHistorySnapshot();
  // Wall-clock-derived: a dialog left open across midnight must notice the
  // day change without a ledger append. Memoized on the shared clock — the
  // full-ledger scan runs per tick/append, never per render.
  const now = useWallClock();
  const days = useMemo(
    () => currentStreakDays(history.events, now),
    [history.events, now],
  );
  if (days === 0) return null;
  const heat = streakHeat(days);
  return (
    <span
      className={`stats__streak stats__streak--${heat}`}
      role="img"
      aria-label={`${days}-day streak`}
    >
      {heat !== "none" && <StreakMark heat={heat} />}
      <b>{days}</b>
      <small>day{days === 1 ? "" : "s"}</small>
    </span>
  );
}

const FLAME_SIZE: Partial<Record<StreakHeat, number>> = {
  flame: 13,
  blaze: 16,
  inferno: 18,
};

/** Rising embers, each with its own drift, tempo and phase. */
const SPARKS = [
  { dx: "5px", dur: "2s", delay: "0s", left: "45%" },
  { dx: "-4px", dur: "2.5s", delay: "0.6s", left: "55%" },
  { dx: "7px", dur: "2.2s", delay: "1.1s", left: "40%" },
  { dx: "-6px", dur: "2.7s", delay: "1.6s", left: "60%" },
  { dx: "3px", dur: "1.9s", delay: "2.1s", left: "50%" },
];

function StreakMark({ heat }: { heat: StreakHeat }) {
  const id = useId();
  if (heat === "ember") {
    return (
      <span className="stats__streak-mark" aria-hidden>
        <span className="stats__streak-glow stats__streak-glow--wide" />
        <span className="stats__streak-coal" />
      </span>
    );
  }
  const size = FLAME_SIZE[heat] ?? 13;
  return (
    <span
      className={`stats__streak-mark${
        heat === "inferno" ? " stats__streak-mark--inferno" : ""
      }`}
      aria-hidden
    >
      <span className="stats__streak-glow" />
      <svg
        className="stats__streak-fire"
        width={size}
        height={size + 1}
        viewBox="0 0 24 26"
      >
        {/* Gradient STRUCTURE only — every color of the fire lives in
            stats-streak.css (stop-color/fill are CSS-styleable), so the
            planned design pass recolors one file, not two. */}
        <defs>
          <linearGradient id={`${id}-flame`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="stats__streak-stop-flame-top" />
            <stop offset="0.55" className="stats__streak-stop-flame-mid" />
            <stop offset="1" className="stats__streak-stop-flame-base" />
          </linearGradient>
          <linearGradient id={`${id}-core`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="stats__streak-stop-core-top" />
            <stop offset="1" className="stats__streak-stop-core-base" />
          </linearGradient>
        </defs>
        <path
          fill={`url(#${id}-flame)`}
          d="M12 2 C13 6 17 8 18.5 12 C19.6 15 19.3 18 17.5 20.6 C15 24.2 9 24.2 6.5 20.6 C4.7 18 4.4 15 5.5 12 C7 8 11 6 12 2 Z"
        />
        <path
          className="stats__streak-core"
          fill={`url(#${id}-core)`}
          d="M12 10 C13.5 12.5 15.5 13.8 15.5 16.8 C15.5 19.6 14 21.5 12 21.5 C10 21.5 8.5 19.6 8.5 16.8 C8.5 13.8 10.5 12.5 12 10 Z"
        />
        {heat === "inferno" && (
          <path
            className="stats__streak-hot"
            d="M12 15 C12.9 16.2 13.7 16.9 13.7 18.3 C13.7 19.7 13 20.6 12 20.6 C11 20.6 10.3 19.7 10.3 18.3 C10.3 16.9 11.1 16.2 12 15 Z"
          />
        )}
      </svg>
      {heat === "inferno" &&
        SPARKS.map((spark) => (
          <i
            key={`${spark.left}-${spark.delay}`}
            className="stats__streak-spark"
            style={
              {
                "--dx": spark.dx,
                "--dur": spark.dur,
                "--delay": spark.delay,
                left: spark.left,
              } as React.CSSProperties
            }
          />
        ))}
    </span>
  );
}
