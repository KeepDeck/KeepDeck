import { useId } from "react";
import { useStreakDays } from "../../app/useStreakDays";
import { streakView, type StreakMarkView } from "../../presentation/stats/streakView";

/**
 * The live streak chip. What it says and which mark each heat tier wears
 * are settled in presentation/stats/streakView.ts; this draws them —
 * hand-drawn SVG, all CSS animation; everything bows out under
 * prefers-reduced-motion.
 *
 * ACCEPTED PROVISIONALLY (user, 2026-08-01): the visual treatment is "good
 * enough for now" — a dedicated design pass is planned separately.
 *
 * Self-sufficient (asks for the number itself, takes no props) so it can sit
 * in the dialog's footer corner, outside the tab body. WHAT counts as an
 * active day, and how the clock is floored, belong to [`useStreakDays`] and
 * the witness behind it — the chip only draws the answer.
 */
export function StreakBadge() {
  const view = streakView(useStreakDays());
  if (!view) return null;
  return (
    <span className={`stats__streak stats__streak--${view.heat}`} role="img" aria-label={view.label}>
      <StreakMark mark={view.mark} />
      <b>{view.count}</b>
      <small>{view.unit}</small>
    </span>
  );
}

function StreakMark({ mark }: { mark: StreakMarkView }) {
  const id = useId();
  if (mark.kind === "none") return null;
  if (mark.kind === "coal") {
    return (
      <span className="stats__streak-mark" aria-hidden>
        <span className="stats__streak-glow stats__streak-glow--wide" />
        <span className="stats__streak-coal" />
      </span>
    );
  }
  return (
    <span className={`stats__streak-mark${mark.inferno ? " stats__streak-mark--inferno" : ""}`} aria-hidden>
      <span className="stats__streak-glow" />
      <svg className="stats__streak-fire" width={mark.size} height={mark.size + 1} viewBox="0 0 24 26">
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
        {mark.inferno && (
          <path
            className="stats__streak-hot"
            d="M12 15 C12.9 16.2 13.7 16.9 13.7 18.3 C13.7 19.7 13 20.6 12 20.6 C11 20.6 10.3 19.7 10.3 18.3 C10.3 16.9 11.1 16.2 12 15 Z"
          />
        )}
      </svg>
      {mark.sparks.map((spark) => (
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
