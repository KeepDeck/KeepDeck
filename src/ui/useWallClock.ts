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
 * Data claiming a slightly future instant advances the view of now with
 * it, which self-corrects on the next tick and beats hiding fresh data.
 */
export function useWallClock(atLeast = 0): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(now, atLeast);
}
