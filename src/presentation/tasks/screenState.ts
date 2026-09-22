/**
 * The dialog's screen as a state machine with no React in it: which
 * team, which view, what is folded, whether the form or the wide view is
 * up, which column a drag hovers — and every transition between them,
 * with the effects a transition owes the outside (the open task to set,
 * the dialog to close). The hook holds one state and applies what this
 * answers; it decides nothing.
 */
import type { TaskStatus } from "../../domain/tasks";
import type { BoardColumnView } from "./boardView";
import { escapeTarget, selectionAfterClick, toggledFold, type TasksMode } from "./dialogState";

export interface ScreenState {
  mode: TasksMode;
  showCancelled: boolean;
  /** The person's explicit Hide/Show per closed column. */
  folds: ReadonlyMap<TaskStatus, boolean>;
  /** The team they picked; the team on screen is `teamOnScreen`'s call. */
  chosenTeam: string | null;
  /** The new-task form is up. */
  composing: boolean;
  /** The open task fills the stage. Meaningful only with a task open —
   * read it through [`wideView`]. */
  wide: boolean;
  /** The column a card in flight is over. */
  hover: TaskStatus | null;
}

export const INITIAL_SCREEN: ScreenState = {
  mode: "board",
  showCancelled: false,
  folds: new Map(),
  chosenTeam: null,
  composing: false,
  wide: false,
  hover: null,
};

export type ScreenAction =
  /** A card was clicked; `open` is the task open now, if any. */
  | { type: "card"; id: string; open: string | null }
  /** Put the open task away. */
  | { type: "close" }
  | { type: "compose" }
  | { type: "cancelCompose" }
  /** The + Task button: opens the form, or closes it when it is up. */
  | { type: "toggleCompose" }
  | { type: "toggleWide"; detailOpen: boolean }
  | { type: "narrow" }
  | { type: "escape"; detailOpen: boolean }
  | { type: "team"; id: string }
  | { type: "mode"; mode: TasksMode }
  | { type: "toggleCancelled" }
  | { type: "fold"; status: TaskStatus; columns: readonly BoardColumnView[] }
  | { type: "hover"; status: TaskStatus | null; dragging: boolean }
  /** A task was created from the form: it opens, the form goes. */
  | { type: "created"; id: string };

export interface ScreenOutcome {
  state: ScreenState;
  /** The task to make the open one — null to open none. Absent: unchanged. */
  focus?: string | null;
  /** The whole dialog closes. */
  closeDialog?: true;
}

/**
 * The one way in. `onScreen` is the team the board shows as the person
 * acts, null when it shows none: whatever that is becomes their choice
 * from then on, so putting a task away or opening the form never moves
 * the board — a board opened on another team's task by a link used to
 * fall back to the first team the moment the task was put away, and the
 * form on it created into that team. Pinned once, here, before `step`
 * and every transition it delegates to.
 */
export function screenReducer(state: ScreenState, action: ScreenAction, onScreen: string | null): ScreenOutcome {
  return step(onScreen === null || onScreen === state.chosenTeam ? state : { ...state, chosenTeam: onScreen }, action);
}

function step(state: ScreenState, action: ScreenAction): ScreenOutcome {
  switch (action.type) {
    case "card": {
      const focus = selectionAfterClick(action.open, action.id);
      return { state: { ...state, composing: false, wide: focus === null ? false : state.wide }, focus };
    }
    case "close":
      return { state: { ...state, wide: false }, focus: null };
    case "compose":
      return { state: { ...state, composing: true, wide: false }, focus: null };
    case "cancelCompose":
      return { state: { ...state, composing: false } };
    case "toggleCompose":
      return step(state, { type: state.composing ? "cancelCompose" : "compose" });
    case "toggleWide":
      // Wide only with a task to fill the stage.
      return { state: { ...state, wide: action.detailOpen ? !state.wide : false } };
    case "narrow":
      return { state: { ...state, wide: false } };
    case "escape":
      switch (escapeTarget({ composing: state.composing, wide: state.wide, detailOpen: action.detailOpen })) {
        case "form":
          return step(state, { type: "cancelCompose" });
        case "wide":
          return step(state, { type: "narrow" });
        case "detail":
          return step(state, { type: "close" });
        case "dialog":
          return { state, closeDialog: true };
      }
      break;
    case "team":
      // Another team's board: whatever was open belongs to the old one.
      return { state: { ...state, chosenTeam: action.id, wide: false }, focus: null };
    case "mode":
      return { state: { ...state, mode: action.mode } };
    case "toggleCancelled":
      return { state: { ...state, showCancelled: !state.showCancelled } };
    case "fold": {
      const fold = toggledFold(action.columns, action.status);
      if (fold === null) return { state };
      return { state: { ...state, folds: new Map(state.folds).set(action.status, fold) } };
    }
    case "hover":
      // Only a card in flight has a column under it.
      return { state: { ...state, hover: action.dragging ? action.status : null } };
    case "created":
      return { state: { ...state, composing: false, wide: false }, focus: action.id };
  }
  return { state };
}

/** Whether the stage shows the open task wide: the flag, and a task. */
export function wideView(state: ScreenState, detailOpen: boolean): boolean {
  return state.wide && detailOpen;
}
