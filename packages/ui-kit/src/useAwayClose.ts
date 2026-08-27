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
    const away = (event: Event) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !layerRef.current?.contains(target)
      ) {
        closeRef.current();
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("focusin", away, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("focusin", away, true);
    };
  }, [open, rootRef, layerRef]);
}
