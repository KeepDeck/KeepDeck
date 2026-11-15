import { useEffect, type RefObject } from "react";

/**
 * THE scroll exit of a pointer-driven tip, for every surface that has one —
 * the shared Tooltip, the burn plots' hover card, a minimized pane's details.
 * A scroll moves the anchor out from under a still cursor, and no mouse event
 * says so until the mouse moves; the tip rode along with its anchor instead
 * of closing (user, 2026-11-15). While `active` — the cursor's tip is pending
 * or up — a scroll anywhere in the anchor's window is the cursor leaving.
 * Captured, so a dialog's own scroller counts: its scroll does not bubble.
 * Each surface says what leaving means for it; a tip held by focus or the
 * keys is its business to keep.
 */
export function useScrollExit(active: boolean, anchor: RefObject<Element | null>, onExit: () => void): void {
  useEffect(() => {
    if (!active) return;
    const view = anchor.current?.ownerDocument.defaultView;
    view?.addEventListener("scroll", onExit, true);
    return () => view?.removeEventListener("scroll", onExit, true);
  }, [active, anchor, onExit]);
}
