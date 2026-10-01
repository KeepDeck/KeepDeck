import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
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
 */
export function useStripReveal(suspended: boolean) {
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

  return {
    open: state.open,
    dismiss: () => dispatch({ kind: "dismiss" }),
    handlers: {
      onPointerEnter: () => dispatch({ kind: "enter" }),
      onPointerLeave: () => dispatch({ kind: "leave" }),
      onPointerDown: () => dispatch({ kind: "press" }),
    },
  };
}
