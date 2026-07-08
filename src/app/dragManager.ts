import { useCallback, useEffect, useRef } from "react";

export interface DragPoint {
  x: number;
  y: number;
}

export interface PointerDragFrame<T> {
  source: T;
  pointerId: number;
  start: DragPoint;
  current: DragPoint;
  delta: DragPoint;
  event: PointerEvent | null;
}

type CancelReason =
  | "cancelled"
  | "contextmenu"
  | "escape"
  | "lost-window"
  | "prestart-move"
  | "replaced";

interface PointerDragSession<T> {
  source: T;
  pointerId: number;
  start: DragPoint;
  current: DragPoint;
  timer: number | null;
  dragging: boolean;
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
  onCancel: () => void;
  onContextMenu: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onVisibilityChange: () => void;
}

export interface PointerDragOptions<T> {
  holdMs?: number;
  startThresholdPx?: number;
  cancelBeforeStartPx?: number;
  suppressClickAfterDrop?: boolean;
  onStart?(frame: PointerDragFrame<T>): void;
  onMove?(frame: PointerDragFrame<T>): void;
  onDrop?(frame: PointerDragFrame<T>): void;
  onCancel?(frame: PointerDragFrame<T>, reason: CancelReason): void;
}

/** Shared pointer-drag lifecycle for in-app drags. It owns the fragile browser
 * pieces (global listeners, lost-window cleanup, click suppression and latest
 * callback refs) while feature code keeps domain-specific hit-testing/drop work. */
export function usePointerDrag<T>(options: PointerDragOptions<T>) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionRef = useRef<PointerDragSession<T> | null>(null);

  const clearSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.timer !== null) window.clearTimeout(session.timer);
    window.removeEventListener("pointermove", session.onMove, true);
    window.removeEventListener("pointerup", session.onUp, true);
    window.removeEventListener("pointercancel", session.onCancel, true);
    window.removeEventListener("blur", session.onCancel);
    window.removeEventListener("contextmenu", session.onContextMenu, true);
    document.removeEventListener("keydown", session.onKeyDown, true);
    document.removeEventListener(
      "visibilitychange",
      session.onVisibilityChange,
      true,
    );
    sessionRef.current = null;
  }, []);

  const cancelDrag = useCallback(
    (reason: CancelReason = "cancelled") => {
      const session = sessionRef.current;
      if (!session) return;
      const frame = frameFor(session, null);
      const wasDragging = session.dragging;
      clearSession();
      if (wasDragging) optionsRef.current.onCancel?.(frame, reason);
    },
    [clearSession],
  );

  const startPointerDrag = useCallback(
    (event: PointerEvent, source: T) => {
      if (event.button !== 0) return;
      if ("isPrimary" in event && !event.isPrimary) return;
      cancelDrag("replaced");

      const holdMs = optionsRef.current.holdMs ?? 0;
      const startThresholdPx = optionsRef.current.startThresholdPx ?? 0;
      const cancelBeforeStartPx = optionsRef.current.cancelBeforeStartPx;
      const start = pointFrom(event);

      const beginDrag = (session: PointerDragSession<T>, ev: PointerEvent | null) => {
        if (session.dragging) return;
        if (session.timer !== null) {
          window.clearTimeout(session.timer);
          session.timer = null;
        }
        session.dragging = true;
        optionsRef.current.onStart?.(frameFor(session, ev));
      };

      const onMove = (ev: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || session.pointerId !== ev.pointerId) return;
        session.current = pointFrom(ev);
        const distance = distanceFrom(session.start, session.current);
        if (!session.dragging) {
          if (
            cancelBeforeStartPx !== undefined &&
            distance > cancelBeforeStartPx
          ) {
            cancelDrag("prestart-move");
            return;
          }
          if (holdMs <= 0 && distance >= startThresholdPx) beginDrag(session, ev);
          else return;
        }
        ev.preventDefault();
        optionsRef.current.onMove?.(frameFor(session, ev));
      };

      const onUp = (ev: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || session.pointerId !== ev.pointerId) return;
        session.current = pointFrom(ev);
        const wasDragging = session.dragging;
        const frame = frameFor(session, ev);
        clearSession();
        if (!wasDragging) return;
        ev.preventDefault();
        optionsRef.current.onDrop?.(frame);
        if (optionsRef.current.suppressClickAfterDrop ?? true) suppressNextClick();
      };

      const onCancel = () => cancelDrag("lost-window");
      const onContextMenu = () => cancelDrag("contextmenu");
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") cancelDrag("escape");
      };
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") cancelDrag("lost-window");
      };

      const session: PointerDragSession<T> = {
        source,
        pointerId: event.pointerId,
        start,
        current: start,
        timer: null,
        dragging: false,
        onMove,
        onUp,
        onCancel,
        onContextMenu,
        onKeyDown,
        onVisibilityChange,
      };
      if (holdMs > 0) {
        session.timer = window.setTimeout(() => {
          if (sessionRef.current === session) beginDrag(session, null);
        }, holdMs);
      } else if (startThresholdPx <= 0) {
        beginDrag(session, event);
      }
      sessionRef.current = session;

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      window.addEventListener("blur", onCancel);
      window.addEventListener("contextmenu", onContextMenu, true);
      document.addEventListener("keydown", onKeyDown, true);
      document.addEventListener("visibilitychange", onVisibilityChange, true);
    },
    [cancelDrag, clearSession],
  );

  useEffect(() => () => clearSession(), [clearSession]);

  return { startPointerDrag, cancelDrag };
}

export interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type ElementRectSnapshot = Map<string, ElementRect>;

export function snapshotElementRects(
  elements: Iterable<HTMLElement>,
  idOf: (element: HTMLElement) => string,
): ElementRectSnapshot {
  const snapshot = new Map<string, ElementRect>();
  for (const element of elements) {
    const id = idOf(element);
    if (!id) continue;
    const rect = element.getBoundingClientRect();
    snapshot.set(id, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }
  return snapshot;
}

export function animateElementReorder(
  elements: Iterable<HTMLElement>,
  idOf: (element: HTMLElement) => string,
  before: ElementRectSnapshot | null,
  options: { durationMs?: number; easing?: string } = {},
): void {
  if (!before || prefersReducedMotion()) return;
  const durationMs = options.durationMs ?? 140;
  const easing = options.easing ?? "cubic-bezier(0.2, 0, 0, 1)";
  for (const element of elements) {
    const id = idOf(element);
    const previous = before.get(id);
    if (!previous) continue;
    const next = element.getBoundingClientRect();
    const dx = previous.left - next.left;
    const dy = previous.top - next.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    const oldTransition = element.style.transition;
    const oldTransform = element.style.transform;
    const oldWillChange = element.style.willChange;
    element.style.transition = "none";
    element.style.transform = `translate(${dx}px, ${dy}px)`;
    element.style.willChange = "transform";
    void element.offsetWidth;
    requestFrame(() => {
      element.style.transition = `transform ${durationMs}ms ${easing}`;
      element.style.transform = oldTransform;
      const cleanup = () => {
        element.removeEventListener("transitionend", cleanup);
        window.clearTimeout(timeout);
        element.style.transition = oldTransition;
        element.style.willChange = oldWillChange;
      };
      const timeout = window.setTimeout(cleanup, durationMs + 80);
      element.addEventListener("transitionend", cleanup);
    });
  }
}

export function animateFixedElementToRect(
  element: HTMLElement,
  target: ElementRect,
  options: {
    durationMs?: number;
    easing?: string;
    opacity?: number;
    transform?: string;
    onDone?: () => void;
  } = {},
): () => void {
  const durationMs = options.durationMs ?? 140;
  const easing = options.easing ?? "cubic-bezier(0.2, 0, 0, 1)";
  if (prefersReducedMotion()) {
    options.onDone?.();
    return () => {};
  }

  let done = false;
  let frame = 0;
  const oldTransition = element.style.transition;
  const finish = () => {
    if (done) return;
    done = true;
    if (frame) cancelFrame(frame);
    window.clearTimeout(timeout);
    element.removeEventListener("transitionend", finish);
    element.style.transition = oldTransition;
    options.onDone?.();
  };
  const timeout = window.setTimeout(finish, durationMs + 100);
  element.addEventListener("transitionend", finish);
  element.style.transition = [
    `top ${durationMs}ms ${easing}`,
    `left ${durationMs}ms ${easing}`,
    `width ${durationMs}ms ${easing}`,
    `height ${durationMs}ms ${easing}`,
    `opacity ${durationMs}ms ${easing}`,
    `transform ${durationMs}ms ${easing}`,
  ].join(", ");
  void element.offsetWidth;
  frame = requestFrame(() => {
    element.style.left = `${target.left}px`;
    element.style.top = `${target.top}px`;
    element.style.width = `${target.width}px`;
    element.style.height = `${target.height}px`;
    if (options.opacity !== undefined) element.style.opacity = `${options.opacity}`;
    if (options.transform !== undefined) element.style.transform = options.transform;
  });
  return () => {
    if (done) return;
    done = true;
    if (frame) cancelFrame(frame);
    window.clearTimeout(timeout);
    element.removeEventListener("transitionend", finish);
    element.style.transition = oldTransition;
  };
}

function frameFor<T>(
  session: PointerDragSession<T>,
  event: PointerEvent | null,
): PointerDragFrame<T> {
  return {
    source: session.source,
    pointerId: session.pointerId,
    start: session.start,
    current: session.current,
    delta: {
      x: session.current.x - session.start.x,
      y: session.current.y - session.start.y,
    },
    event,
  };
}

function pointFrom(event: PointerEvent): DragPoint {
  return { x: event.clientX, y: event.clientY };
}

function distanceFrom(a: DragPoint, b: DragPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function suppressNextClick(): void {
  const onClick = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    cleanup();
  };
  const cleanup = () => document.removeEventListener("click", onClick, true);
  document.addEventListener("click", onClick, true);
  setTimeout(cleanup, 0);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(performance.now()), 0);
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else window.clearTimeout(id);
}
