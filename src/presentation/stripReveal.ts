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

export interface RevealState {
  open: boolean;
  /** The pointer is over the column. */
  inside: boolean;
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
  suspended: false,
  dwelling: false,
  closing: false,
};

export type RevealEvent =
  | { kind: "enter" }
  | { kind: "leave" }
  /** A press: a click or the start of a hold-to-drag — never a request to
   * read, so it cancels a pending open. */
  | { kind: "press" }
  /** The press let go: on the column, the rest starts over. */
  | { kind: "release" }
  | { kind: "dwelled" }
  | { kind: "graced" }
  | { kind: "drag-start" }
  | { kind: "drag-end" };

export function stripReveal(state: RevealState, event: RevealEvent): RevealState {
  switch (event.kind) {
    case "enter":
      return {
        ...state,
        inside: true,
        // Back inside the grace: it was never meant to shut.
        closing: false,
        dwelling: !state.suspended && !state.open,
      };
    case "leave":
      return {
        ...state,
        inside: false,
        dwelling: false,
        // A drag carries the pointer anywhere: the strip holds until it
        // drops.
        closing: !state.suspended && state.open,
      };
    case "press":
      return { ...state, dwelling: false };
    case "release":
      // A press cancels the rest, not the opening: let go on the column,
      // and it opens after a rest again.
      return { ...state, dwelling: state.inside && !state.open && !state.suspended };
    case "dwelled":
      return state.dwelling ? { ...state, dwelling: false, open: true } : state;
    case "graced":
      return state.closing ? { ...state, closing: false, open: false } : state;
    case "drag-start":
      // Held as it is — open stays open, shut stays shut.
      return { ...state, suspended: true, dwelling: false, closing: false };
    case "drag-end":
      // The pointer decides: still on the column, the strip stays (or
      // opens after the rest — no pointer ENTERS a column it never left);
      // off it, it shuts after the grace.
      return {
        ...state,
        suspended: false,
        dwelling: state.inside && !state.open,
        closing: !state.inside && state.open,
      };
  }
}
