/**
 * The strip's slide-out, decided: when resting the pointer opens it, when
 * leaving shuts it, and what a press, a choice or a drag does to that.
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
  /** Shut by a choice made in it; stays shut until the pointer leaves. */
  dismissed: boolean;
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
  dismissed: false,
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
  | { kind: "dwelled" }
  | { kind: "graced" }
  /** A choice was made in it (a workspace, a team). */
  | { kind: "dismiss" }
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
        dwelling: !state.suspended && !state.open && !state.dismissed,
      };
    case "leave":
      return {
        ...state,
        inside: false,
        dismissed: false,
        dwelling: false,
        // A drag carries the pointer anywhere: the strip holds until it
        // drops.
        closing: !state.suspended && state.open,
      };
    case "press":
      return { ...state, dwelling: false };
    case "dwelled":
      return state.dwelling ? { ...state, dwelling: false, open: true } : state;
    case "graced":
      return state.closing ? { ...state, closing: false, open: false } : state;
    case "dismiss":
      return { ...state, open: false, dismissed: true, dwelling: false, closing: false };
    case "drag-start":
      // Held as it is — open stays open, shut stays shut. A drag is a new
      // gesture: an earlier choice no longer keeps the strip shut.
      return { ...state, suspended: true, dwelling: false, closing: false, dismissed: false };
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
