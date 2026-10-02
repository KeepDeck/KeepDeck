import { useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from "react";
import {
  REVEAL_AT_REST,
  STRIP_REVEAL_DWELL_MS,
  STRIP_REVEAL_GRACE_MS,
  stripReveal,
} from "../../presentation/stripReveal";

/**
 * The strip's slide-out, wired: the rules are `stripReveal`'s; this keeps
 * its two timers — one runs exactly while `dwelling` is set, the other
 * while `closing` is — and feeds it the pointer and the drag.
 *
 * WHERE the pointer is comes from the document, not from enter/leave on
 * the column: those are synthesized from pointerover/out pairs, and a
 * pair that never comes left the strip shut under the pointer or open
 * after it had gone — a dialog opening over a resting pointer, a fast exit
 * through the window's edge, a sleep. Every pointer event the document
 * sees says again whether the topmost thing under the pointer is part of
 * the column (an overlay covering the column is not — the hit test, not a
 * rectangle), so a missed crossing is caught by the next move. Leaving the
 * window, losing focus and hiding the page count as leaving: when in
 * doubt the strip shuts rather than sticks.
 */
export function useStripReveal(column: RefObject<HTMLElement | null>, suspended: boolean) {
  const [state, dispatch] = useReducer(stripReveal, REVEAL_AT_REST);

  useEffect(() => {
    if (!state.dwelling) return;
    const timer = window.setTimeout(() => dispatch({ kind: "dwelled" }), STRIP_REVEAL_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [state.dwelling]);

  useEffect(() => {
    if (!state.closing) return;
    const timer = window.setTimeout(() => dispatch({ kind: "graced" }), STRIP_REVEAL_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [state.closing]);

  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    dispatch({ kind: suspended ? "drag-start" : "drag-end" });
  }, [suspended]);

  useEffect(() => {
    // The machine hears a crossing once: `inside` here is what it was told.
    let inside = false;
    const sync = (now: boolean) => {
      if (now === inside) return;
      inside = now;
      dispatch({ kind: now ? "enter" : "leave" });
    };
    const within = (node: EventTarget | null) =>
      node instanceof Node && (column.current?.contains(node) ?? false);
    // The element now under the pointer: the event's target, or — for an
    // out — the one it went to (null: out of the window).
    const onOver = (e: PointerEvent) => sync(within(e.target));
    const onOut = (e: PointerEvent) => sync(within(e.relatedTarget));
    const onDown = (e: PointerEvent) => {
      sync(within(e.target));
      if (inside) dispatch({ kind: "press" });
    };
    const onUp = (e: PointerEvent) => {
      sync(within(e.target));
      if (inside) dispatch({ kind: "release" });
    };
    const gone = () => sync(false);
    const onHidden = () => {
      if (document.visibilityState === "hidden") gone();
    };
    const opts = { capture: true, passive: true } as const;
    document.addEventListener("pointerover", onOver, opts);
    document.addEventListener("pointermove", onOver, opts);
    document.addEventListener("pointerout", onOut, opts);
    document.addEventListener("pointerdown", onDown, opts);
    document.addEventListener("pointerup", onUp, opts);
    document.documentElement.addEventListener("mouseleave", gone);
    window.addEventListener("blur", gone);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("pointerover", onOver, opts);
      document.removeEventListener("pointermove", onOver, opts);
      document.removeEventListener("pointerout", onOut, opts);
      document.removeEventListener("pointerdown", onDown, opts);
      document.removeEventListener("pointerup", onUp, opts);
      document.documentElement.removeEventListener("mouseleave", gone);
      window.removeEventListener("blur", gone);
      document.removeEventListener("visibilitychange", onHidden);
    };
    // The column is the strip's own element, mounted with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { open: state.open };
}
