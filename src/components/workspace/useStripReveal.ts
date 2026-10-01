import { useEffect, useRef, useState } from "react";

/** How long the pointer rests on the strip before it opens. Under the
 * 300ms hold that arms a reorder drag, so the press has to cancel it — see
 * `onPointerDown`. */
export const STRIP_REVEAL_DWELL_MS = 250;

/** How long the strip stays open after the pointer leaves it. Its rows are
 * clickable — a team is a target — and a pointer that overshoots the edge
 * on its way to one must not lose the whole column; coming back inside the
 * grace keeps it open. */
export const STRIP_REVEAL_GRACE_MS = 200;

/**
 * The strip's slide-out: resting the pointer on the column opens it over
 * the stage with every workspace's name and teams; leaving closes it after
 * a short grace. A press cancels an open that is still pending — a press
 * is a click or the start of a hold-to-drag, never a request to read — and
 * a drag in flight (`suspended`) closes it. When the drag ends with the
 * pointer still on the column, the rest starts over: no pointer ENTERS a
 * column it never left, so waiting for one would leave it shut.
 *
 * `dismiss()` closes it after a choice was made in it (a workspace, a
 * team) and keeps it shut until the pointer leaves: the pointer is still
 * over the column, and reopening under it would undo the choice's close.
 */
export function useStripReveal(suspended: boolean) {
  const [open, setOpen] = useState(false);
  const pending = useRef<number | null>(null);
  const closing = useRef<number | null>(null);
  /** Whether the pointer is on the column — what a drop resumes from. */
  const inside = useRef(false);
  /** Closed by a choice: stays shut until the pointer has left. */
  const dismissed = useRef(false);

  const clear = (timer: { current: number | null }) => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  };

  const openAfterDwell = () => {
    clear(pending);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      setOpen(true);
    }, STRIP_REVEAL_DWELL_MS);
  };

  useEffect(
    () => () => {
      clear(pending);
      clear(closing);
    },
    [],
  );

  useEffect(() => {
    if (suspended) {
      clear(pending);
      clear(closing);
      setOpen(false);
    } else if (inside.current && !dismissed.current) {
      openAfterDwell();
    }
  }, [suspended]);

  return {
    open: open && !suspended,
    dismiss: () => {
      clear(pending);
      clear(closing);
      dismissed.current = true;
      setOpen(false);
    },
    handlers: {
      onPointerEnter: () => {
        inside.current = true;
        // Back inside the grace: it was never meant to shut.
        clear(closing);
        if (suspended || open || dismissed.current) return;
        openAfterDwell();
      },
      onPointerLeave: () => {
        inside.current = false;
        dismissed.current = false;
        clear(pending);
        clear(closing);
        closing.current = window.setTimeout(() => {
          closing.current = null;
          setOpen(false);
        }, STRIP_REVEAL_GRACE_MS);
      },
      onPointerDown: () => clear(pending),
    },
  };
}
