import { useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from "react";
import {
  REVEAL_AT_REST,
  STRIP_REVEAL_DWELL_MS,
  STRIP_POINTER_CHECK_MS,
  STRIP_REVEAL_GRACE_MS,
  STRIP_FOCUS_ASK_MS,
  STRIP_FOCUS_ASKS,
  afterFocus,
  revealEventsOf,
  stripReveal,
  type PointerEvidence,
} from "../../presentation/stripReveal";
import { pointerInWindow, pointerOnWindow } from "../../ipc/window";


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
 * doubt the strip shuts rather than sticks. And a pointer that leaves the
 * window fast through its edge sends the page NOTHING (WKWebView, seen
 * live) — so while the strip is open the OS is asked where the pointer
 * is (`pointerInWindow`), and outside the window is a leave. Nor does the
 * page hear a pointer that rests on the strip of an inactive window: the
 * OS sends it no move, and the click that brings the window forward does
 * not reach it, or only as a pointerover with the button held, its let-go
 * never — so when the window comes to the front, the OS is asked where
 * the pointer rests and whether the button is held (`pointerOnWindow`),
 * again until it is let go (`afterFocus`), and the strip opens after the
 * rest as if the pointer had just come.
 */
export function useStripReveal(column: RefObject<HTMLElement | null>, suspended: boolean) {
  const [state, dispatch] = useReducer(stripReveal, REVEAL_AT_REST);
  // Pointer events seen so far: an OS answer asked before the latest one
  // is stale — the page has heard the pointer since.
  const seen = useRef(0);
  // Of them, the ones with no button held: after the window comes to the
  // front, only such an event tells the page where the pointer rests — the
  // click that brought it forward arrives as one with the button held, and
  // its let-go never does.
  const seenFree = useRef(0);

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
    if (!state.open || state.suspended) return;
    let alive = true;
    const stop = () => {
      alive = false;
      window.clearInterval(timer);
    };
    const timer = window.setInterval(() => {
      const asked = seen.current;
      pointerInWindow().then(
        (inWindow) => {
          if (!alive) return;
          // The OS cannot say (no native answer here): stop asking.
          if (inWindow === null) stop();
          else if (!inWindow && seen.current === asked) dispatch({ kind: "leave" });
        },
        // Unanswered (no OS behind the page): the page's own events stand.
        () => {},
      );
    }, STRIP_POINTER_CHECK_MS);
    return stop;
  }, [state.open, state.suspended]);

  useEffect(() => {
    const inColumn = (node: EventTarget | null) =>
      node instanceof Node && (column.current?.contains(node) ?? false);
    // Every pointer event is told as facts (`revealEventsOf`); the machine
    // changes nothing on a fact it already holds.
    const tell = (type: PointerEvidence["type"], e: PointerEvent, under: EventTarget | null) => {
      seen.current += 1;
      if (e.buttons === 0 && type !== "down") seenFree.current += 1;
      for (const event of revealEventsOf({ type, inColumn: inColumn(under), buttons: e.buttons })) {
        dispatch(event);
      }
    };
    const onOver = (e: PointerEvent) => tell("over", e, e.target);
    const onMove = (e: PointerEvent) => tell("move", e, e.target);
    const onOut = (e: PointerEvent) => tell("out", e, e.relatedTarget);
    const onDown = (e: PointerEvent) => tell("down", e, e.target);
    const onUp = (e: PointerEvent) => tell("up", e, e.target);
    const onCancel = (e: PointerEvent) => tell("cancel", e, e.target);
    // Fail-closed. A blur also fires when focus moves INTO an iframe of
    // this window (a plugin taking it by script): the strip shuts under a
    // resting pointer and opens again on the next move and rest — a
    // flicker, never a stuck strip.
    // The asks after the window came to the front: one run at a time — a
    // new focus, a blur or the strip going away ends the one in flight.
    let focusRun = 0;
    let focusTimer: number | undefined;
    const endFocusRun = () => {
      focusRun += 1;
      window.clearTimeout(focusTimer);
    };
    const gone = () => {
      endFocusRun();
      dispatch({ kind: "leave" });
    };
    const onFocus = () => {
      endFocusRun();
      const run = focusRun;
      const free = seenFree.current;
      const ask = (asksLeft: number) =>
        pointerOnWindow().then(
          (point) => {
            if (run !== focusRun) return;
            const under = point && inColumn(document.elementFromPoint(point.x, point.y));
            const next = afterFocus({
              point: point && { inColumn: under === true, pressed: point.pressed },
              heardFree: seenFree.current !== free,
              asksLeft,
            });
            if (next === "ask-again") focusTimer = window.setTimeout(() => void ask(asksLeft - 1), STRIP_FOCUS_ASK_MS);
            else if (next !== "done") for (const event of revealEventsOf(next.tell)) dispatch(event);
          },
          // Unanswered (no OS behind the page): the next pointer event tells.
          () => {},
        );
      void ask(STRIP_FOCUS_ASKS);
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") gone();
    };
    const opts = { capture: true, passive: true } as const;
    const pointer: [string, (e: PointerEvent) => void][] = [
      ["pointerover", onOver],
      ["pointermove", onMove],
      ["pointerout", onOut],
      ["pointerdown", onDown],
      ["pointerup", onUp],
      ["pointercancel", onCancel],
    ];
    for (const [type, fn] of pointer) document.addEventListener(type, fn as EventListener, opts);
    document.documentElement.addEventListener("mouseleave", gone);
    window.addEventListener("blur", gone);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      for (const [type, fn] of pointer) document.removeEventListener(type, fn as EventListener, opts);
      document.documentElement.removeEventListener("mouseleave", gone);
      window.removeEventListener("blur", gone);
      window.removeEventListener("focus", onFocus);
      endFocusRun();
      document.removeEventListener("visibilitychange", onHidden);
    };
    // The column is the strip's own element, mounted with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { open: state.open };
}
