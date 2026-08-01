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

export function useWallClock(atLeast = 0): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return Math.max(now, Math.min(atLeast, now + TICK_MS));
}
