import { useEffect, useState } from "react";

/** The browser's even minute tick. Hidden windows pause and refresh
 * immediately on return so row age labels do not drift while away. */
export function useBrowserClock(): number {
  // THE CLOCK — one EVEN tick per minute, resurrected by demand and
  // cheap NOW: virtualization pinned the visible rows to ~a screenful,
  // so a tick repaints only them — and, since the tick landed INSIDE
  // this component, every input the tick would have walked for
  // nothing (the measurement key callback, the presence cwd list, the
  // stabilized arrays) is memoized on its real sources, or the tick
  // would re-walk the whole queue through the library's memo.
  // HONEST SCOPE of "only the visible": the ROWS in the markup are
  // only the visible; the presence inputs (the cwd array AND the
  // hook's fingerprint over it) are memoized on their real sources —
  // an unrelated render touches no path at all. When the inputs DO
  // change, the fingerprint pass runs over all of them, visible or
  // not. Not rounded in our favor: the queue walk is gone, the input
  // walk on real changes remains.
  // The CONTRACT (the circle's, not a guess): lag up to one minute is
  // accepted (the label is coarse anyway); a hidden window does not
  // count time (the interval pauses on document.hidden); on the
  // window's return the tick fires
  // IMMEDIATELY — no stale minute shown to a returning eye. This is a
  // EVEN tick, deliberately NOT the old incidental refresh: that one
  // recalculated on every render, so an age label changed exactly at
  // the moment a page landed and the row was moving anyway.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => setNow(Date.now()), 60_000);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop(); // a hidden window counts no time
      } else {
        setNow(Date.now()); // immediate recompute on return
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return now;
}
