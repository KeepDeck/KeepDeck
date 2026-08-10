import { useEffect, useState } from "react";

/**
 * THE wall-clock policy for surfaces that render countdowns, ages and
 * staleness: one `now` per component, advanced by a slow 30s tick — stable
 * between ticks, so memoized aggregates keyed on it recompute on the tick
 * (and on data changes), never once per render. Three surfaces had grown
 * three different answers to this; this hook is the single answer.
 *
 * `atLeast` keeps the clock from trailing the DATA it times: a surface
 * whose input can outrun the tick (a ledger append seconds after a tick, a
 * provider report landing on a long-idle chip) passes its newest data
 * instant, and the returned now is never earlier — otherwise an
 * `occurredAt <= now` filter hides a just-recorded event for up to 30s.
 *
 * The floor covers data that outran the TICK, never data claiming the
 * future: an honest instant can lead the stale tick by at most one
 * interval, so `atLeast` is capped a tick ahead. Beyond that it is corrupt
 * input (a skewed clock's row in the never-pruned ledger, a hand-edited
 * file) and must not drive the clock — uncapped, one such row would pin
 * every consumer's now years ahead: real usage vanishes from every rolling
 * window and the "All" timeline sizes itself in decades of buckets.
 */
const TICK_MS = 30_000;

export function useWallClock(
  atLeast = 0,
  /**
   * Whether this surface is currently showing anything dated.
   *
   * A deck runs one of these per pane, and most panes show no age at all —
   * ticking for them is work nobody can see. Turning it back ON re-reads the
   * clock rather than resuming from a stale `now`: a component mounted for an
   * hour before it first needed a date would otherwise stamp its card with
   * the hour-old reading. The pane header grew its own clock for exactly
   * these two reasons and became the fourth answer this hook exists to be
   * the only one of.
   */
  enabled = true,
): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    // Below the tick the state is left untouched, so React bails out and a
    // deck that mounts already-dated costs no extra render.
    setNow((previous) => (Date.now() - previous >= TICK_MS ? Date.now() : previous));
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return Math.max(now, Math.min(atLeast, now + TICK_MS));
}
