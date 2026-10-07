/**
 * The strip's slide-out, decided: when resting the pointer opens it, when
 * leaving shuts it, and what a press or a drag does to that. A choice made
 * in it (a workspace, a team) does NOT shut it: the pointer leaving does,
 * and a person clicking through teams keeps it open between clicks (user
 * decision 2026-10-03).
 * Pure — `(state, event) → state`. The two timers are not hidden in it:
 * `dwelling` and `closing` SAY a timer runs, and the hook beside the strip
 * keeps a real timer exactly while the flag is set, reporting back with
 * `dwelled` / `graced`.
 */

/** How long the pointer rests on the strip before it opens. Under the
 * 300ms hold that arms a reorder drag, so a press must cancel it. */
export const STRIP_REVEAL_DWELL_MS = 250;

/** How long the strip stays open after the pointer leaves. Its rows are
 * targets (a workspace, a team): a pointer overshooting the edge on its
 * way to one must not lose the column; coming back inside keeps it open. */
export const STRIP_REVEAL_GRACE_MS = 200;

/** How often an open strip asks the OS whether the pointer is still in the
 * window: a pointer leaving fast through the window's edge sends the page
 * nothing, and only this notices it went. */
export const STRIP_POINTER_CHECK_MS = 150;

export interface RevealState {
  open: boolean;
  /** The pointer is over the column. */
  inside: boolean;
  /** A button is held — a click on its way, a drag, a selection — wherever
   * it was pressed: no rest is a request to read while it is. */
  pressed: boolean;
  /** A drag is in flight: the strip holds as it is. */
  suspended: boolean;
  /** The open-after-rest timer runs. */
  dwelling: boolean;
  /** The shut-after-grace timer runs. */
  closing: boolean;
}

export const REVEAL_AT_REST: RevealState = {
  open: false,
  inside: false,
  pressed: false,
  suspended: false,
  dwelling: false,
  closing: false,
};

export type RevealEvent =
  | { kind: "enter" }
  | { kind: "leave" }
  /** A button went down (or is seen held): never a request to read, so it
   * cancels a pending open. */
  | { kind: "press" }
  /** No button is held any more — let go, or seen up on a later move after
   * a let-go the page never heard: on the column, the rest starts over. */
  | { kind: "release" }
  | { kind: "dwelled" }
  | { kind: "graced" }
  | { kind: "drag-start" }
  | { kind: "drag-end" };

/** Whether the pointer may rest the strip open from here. */
const mayRest = (state: RevealState) =>
  state.inside && !state.open && !state.pressed && !state.suspended;

/**
 * Every event is a FACT, told as often as the page sees it — the same
 * fact twice changes nothing (the state comes back as it was), so the
 * wiring keeps no copy of what it last told.
 */
export function stripReveal(state: RevealState, event: RevealEvent): RevealState {
  switch (event.kind) {
    case "enter": {
      if (state.inside) return state;
      // Back inside the grace: it was never meant to shut.
      const next = { ...state, inside: true, closing: false };
      return { ...next, dwelling: mayRest(next) };
    }
    case "leave":
      if (!state.inside) return state;
      return {
        ...state,
        inside: false,
        dwelling: false,
        // A drag carries the pointer anywhere: the strip holds until it
        // drops.
        closing: !state.suspended && state.open,
      };
    case "press":
      if (state.pressed) return state;
      return { ...state, pressed: true, dwelling: false };
    case "release": {
      if (!state.pressed) return state;
      // A press cancels the rest, not the opening: let go on the column,
      // and it opens after a rest again.
      const next = { ...state, pressed: false };
      return { ...next, dwelling: mayRest(next) };
    }
    case "dwelled":
      return state.dwelling ? { ...state, dwelling: false, open: true } : state;
    case "graced":
      return state.closing ? { ...state, closing: false, open: false } : state;
    case "drag-start":
      // Held as it is — open stays open, shut stays shut.
      return { ...state, suspended: true, dwelling: false, closing: false };
    case "drag-end": {
      // The pointer decides: still on the column, the strip stays (or
      // opens after the rest — no pointer ENTERS a column it never left);
      // off it, it shuts after the grace.
      const next = { ...state, suspended: false };
      return { ...next, dwelling: mayRest(next), closing: !state.inside && state.open };
    }
  }
}

/** What one pointer event says, read off the DOM by the wiring. */
export interface PointerEvidence {
  /** A pointer event's type — or `focus`: the window came to the front and
   * the OS said where the pointer rests, a fact the page heard no event
   * for (an inactive window is sent none, and the click that activates it
   * does not reach the page). */
  type: "over" | "move" | "out" | "down" | "up" | "cancel" | "focus";
  /** Whether the element now under the pointer is part of the column: the
   * event's target — for an out, the element it went to (none: it left
   * the window). */
  inColumn: boolean;
  /** The buttons held (PointerEvent.buttons). */
  buttons: number;
}

/** The facts one pointer event tells the machine: where the pointer is,
 * and whether a button is held. A down presses; an up or a cancel lets
 * go; any other event tells the buttons as they are — so a let-go the
 * page never heard (a cancel, an up outside the window) is caught by the
 * next move. */
export function revealEventsOf(e: PointerEvidence): RevealEvent[] {
  const where: RevealEvent = { kind: e.inColumn ? "enter" : "leave" };
  switch (e.type) {
    case "down":
      return [where, { kind: "press" }];
    case "up":
    case "cancel":
      return [where, { kind: "release" }];
    case "focus":
      // A pointer resting where the OS found it, its click spent on
      // bringing the window forward: on the column, the rest starts.
      return [where, { kind: "release" }];
    default:
      return [where, { kind: e.buttons === 0 ? "release" : "press" }];
  }
}
