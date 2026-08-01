import { useEffect, useState } from "react";

/**
 * THE wall-clock policy for surfaces that render countdowns, ages and
 * staleness: one `now` per component, advanced by a slow 30s tick — stable
 * between ticks, so memoized aggregates keyed on it recompute on the tick
 * (and on data changes), never once per render. Three surfaces had grown
 * three different answers to this (a bespoke chip tick, a badge-local tick,
 * and no tick at all with per-render `Date.now()` calls that memos silently
 * ignored); this hook is the single answer.
 */
export function useWallClock(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now()); // refresh on (re)activation, then tick slowly
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
