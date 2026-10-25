import { useEffect, useRef, type RefObject } from "react";

/**
 * Close an open layer when the user goes somewhere else.
 *
 * Two ways of leaving, and both have to be watched or the layer outlives the
 * attention that opened it: the pointer presses something outside, or focus
 * Tabs outside. Focus needs its own listener because the layer is portaled to
 * the viewport — it is no longer next to its anchor in the DOM, so nothing
 * about tab order says the two belong together.
 *
 * Both listeners are in the CAPTURE phase, which is the whole point: the layer
 * closes BEFORE the outside control acts on the same press. Otherwise pressing
 * a button behind a menu runs that button with the menu still up, and the two
 * results arrive at once.
 *
 * Escape is deliberately NOT here. It is local to each layer's own element, so
 * a menu inside a dialog swallows Escape only while focus is in the menu and
 * the dialog keeps its own — a window listener would take that away.
 *
 * This exists because `MenuButton` and `Dropdown` had it written out twice,
 * character for character including the comment. "Deliberately the same" was
 * true and is why it must be said once: the first change to the discipline
 * would have landed in one of them, and a menu and a select would have started
 * closing differently for no reason anyone chose.
 */
/** How the user went somewhere: a press, or focus moving. */
export type AwayKind = "pointer" | "focus";

/**
 * Whether an event at `target` has left the layer: it lands outside the
 * anchor (`root`) and outside the portaled layer.
 *
 * One exception, for focus only: focus landing on a SHELL that holds the
 * anchor — a modal overlay, say — has not left. WebKit on macOS gives a
 * pressed button no focus, so pressing an option hands focus up to the
 * nearest focusable ancestor, the overlay; judged away, the menu was gone
 * before the click, and the pick was lost. A press on that same shell is
 * still away: pressing the overlay's empty space closes the layer.
 */
export function isAway(kind: AwayKind, target: Node, root: Node | null, layer: Node | null): boolean {
  if (root?.contains(target) || layer?.contains(target)) return false;
  return !(kind === "focus" && root !== null && target.contains(root));
}

export function useAwayClose(
  open: boolean,
  close: () => void,
  /** The anchor and everything that counts as still-inside it. */
  rootRef: RefObject<Node | null>,
  /** The portaled layer, which the root no longer contains. */
  layerRef: RefObject<Node | null>,
): void {
  // Held in a ref so a caller may pass a fresh closure each render without
  // tearing the listeners down and putting them back up between presses.
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const awayBy = (kind: AwayKind) => (event: Event) => {
      // Only a node can be away from the menu (a window-level focus is not one).
      if (event.target instanceof Node && isAway(kind, event.target, rootRef.current, layerRef.current)) closeRef.current();
    };
    const pressed = awayBy("pointer");
    const focused = awayBy("focus");
    window.addEventListener("pointerdown", pressed, true);
    window.addEventListener("focusin", focused, true);
    return () => {
      window.removeEventListener("pointerdown", pressed, true);
      window.removeEventListener("focusin", focused, true);
    };
  }, [open, rootRef, layerRef]);
}
