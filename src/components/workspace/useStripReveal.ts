import { useEffect, useRef, useState } from "react";

/** How long the pointer rests on the strip before it opens. Under the
 * 300ms hold that arms a reorder drag, so the press has to cancel it — see
 * `onPointerDown`. */
export const STRIP_REVEAL_DWELL_MS = 250;

/**
 * The strip's names-on-approach: resting the pointer on the column opens it
 * over the stage with every workspace's full name beside its mark; leaving
 * closes it at once. A press cancels an open that is still pending — a
 * press is a click or the start of a hold-to-drag, never a request to read
 * names — and a drag in flight (`suspended`) closes it. When the drag ends
 * with the pointer still on the column, the rest starts over: no pointer
 * ENTERS a column it never left, so waiting for one would leave it shut.
 */
export function useStripReveal(suspended: boolean) {
  const [open, setOpen] = useState(false);
  const pending = useRef<number | null>(null);
  /** Whether the pointer is on the column — what a drop resumes from. */
  const inside = useRef(false);

  const cancelPending = () => {
    if (pending.current === null) return;
    window.clearTimeout(pending.current);
    pending.current = null;
  };

  const openAfterDwell = () => {
    cancelPending();
    pending.current = window.setTimeout(() => {
      pending.current = null;
      setOpen(true);
    }, STRIP_REVEAL_DWELL_MS);
  };

  useEffect(() => cancelPending, []);

  useEffect(() => {
    if (suspended) {
      cancelPending();
      setOpen(false);
    } else if (inside.current) {
      openAfterDwell();
    }
  }, [suspended]);

  return {
    open: open && !suspended,
    handlers: {
      onPointerEnter: () => {
        inside.current = true;
        if (suspended || open) return;
        openAfterDwell();
      },
      onPointerLeave: () => {
        inside.current = false;
        cancelPending();
        setOpen(false);
      },
      onPointerDown: cancelPending,
    },
  };
}
