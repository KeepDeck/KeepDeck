import { useEffect, useRef, type RefObject } from "react";

/**
 * Keeps the keyboard's place in a windowed list when the row holding the
 * focus is scrolled out and UNMOUNTED: the browser drops focus to <body>,
 * the next Tab restarts at the page top, and the context is lost. The
 * handoff lands focus on the LIST CONTAINER instead (it needs a
 * `tabIndex={-1}`), so the next Tab enters the nearest mounted row.
 *
 * CONDITIONAL BY CONSTRUCTION: it acts ONLY for the remembered focused
 * element of a row — kept by a focusin listener — once that element is
 * gone from the document AND the browser has already dropped focus to
 * <body>. An ordinary scroll that never focused a row hands nothing over,
 * and focus the person moved elsewhere is not the list's to move.
 *
 * Leaving the list clears the memory only on a REAL move: a focusout whose
 * relatedTarget landed outside the list. A null relatedTarget is kept —
 * a removed node fires no focusout in every engine, and a removal-fired one
 * carries null without the person having gone anywhere; the known edge is a
 * departure to another browsing context, which keeps a stale memory until
 * the next focusin.
 */
export function useFocusHandoff(containerRef: RefObject<HTMLElement | null>): void {
  const focusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      focusedRef.current = target && target !== container ? target : null;
    };
    const onFocusOut = (e: FocusEvent) => {
      const wentTo = e.relatedTarget as HTMLElement | null;
      if (wentTo && !container.contains(wentTo)) focusedRef.current = null;
    };
    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("focusout", onFocusOut);
    return () => {
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
      focusedRef.current = null;
    };
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      const remembered = focusedRef.current;
      if (remembered && !remembered.isConnected && document.activeElement === document.body) {
        container.focus({ preventScroll: true });
        focusedRef.current = null;
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [containerRef]);
}
