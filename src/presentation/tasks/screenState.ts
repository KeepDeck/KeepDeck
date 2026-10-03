/**
 * The dialog's screen as a state machine with no React in it: which
 * team, whether the form or the wide view is up,
 * which column a drag hovers — and every transition between them,
 * with the effects a transition owes the outside (the open task to set,
 * the dialog to close). The hook holds one state and applies what this
 * answers; it decides nothing.
 */
import type { TasksView } from "../../domain/settings";
import type { TaskStatus } from "../../domain/tasks";
import { escapeTarget, selectionAfterClick } from "./dialogState";
import { FOLDED_AT_OPEN, toggleFold } from "./listView";
import { NO_QUERY, withLabel, type TaskQuery } from "./queryView";

/** The two views of the one set of tasks (`queryView`) — a setting, kept
 * across openings (`Settings.tasksView`). */
export type TrackerView = TasksView;

export interface ScreenState {
  /** The team they picked; the team on screen is `teamOnScreen`'s call. */
  chosenTeam: string | null;
  /** The new-task form is up. */
  composing: boolean;
  /** The open task fills the stage. Meaningful only with a task open —
   * read it through [`wideView`]. */
  wide: boolean;
  /** The column a card in flight is over. */
  hover: TaskStatus | null;
  /** The list's folded groups — a reading posture for the dialog's life. */
  folded: ReadonlySet<TaskStatus>;
  /** What the views narrow to, and the team whose board it was set on —
   * read through [`queryOn`]: another team's board shows unnarrowed, its
   * labels being its own, however it came on screen (a pick, or a link to
   * one of its tasks). */
  query: TaskQuery;
  queryTeam: string | null;
}

export const INITIAL_SCREEN: ScreenState = {
  chosenTeam: null,
  composing: false,
  wide: false,
  hover: null,
  folded: FOLDED_AT_OPEN,
  query: NO_QUERY,
  queryTeam: null,
};

/** The screen a dialog opens on: the team the stage has open is the
 * choice it starts from — the person was looking at that team. Null
 * at the cards level, and the board falls back to the first team. */
export function initialScreen(stageTeam: string | null): ScreenState {
  return { ...INITIAL_SCREEN, chosenTeam: stageTeam };
}

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
  | { type: "hover"; status: TaskStatus | null; dragging: boolean }
  /** A list heading's toggle. */
  | { type: "fold"; status: TaskStatus }
  /** A task's move by a drop landed: in the list, its group opens, so the
   * row is seen where it went rather than vanishing into a fold. A drop on
   * the board leaves the list's folds alone. */
  | { type: "dropped"; status: TaskStatus; view: TrackerView }
  /** The toolbar's Blocked toggle. */
  | { type: "blockedOnly" }
  /** A label to narrow to; null, or the one already narrowing, widens. */
  | { type: "label"; label: string | null }
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
    case "hover":
      // Only a card in flight has a column under it.
      return { state: { ...state, hover: action.dragging ? action.status : null } };
    case "created":
      return { state: { ...state, composing: false, wide: false }, focus: action.id };
    case "fold":
      return { state: { ...state, folded: toggleFold(state.folded, action.status) } };
    case "dropped": {
      if (action.view !== "list" || !state.folded.has(action.status)) return { state };
      return { state: { ...state, folded: toggleFold(state.folded, action.status) } };
    }
    case "blockedOnly": {
      const query = queryOn(state, state.chosenTeam);
      return { state: { ...state, query: { ...query, blockedOnly: !query.blockedOnly }, queryTeam: state.chosenTeam } };
    }
    case "label":
      return { state: { ...state, query: withLabel(queryOn(state, state.chosenTeam), action.label), queryTeam: state.chosenTeam } };
  }
  return { state };
}

/** The query the board of `teamId` shows: the one set on it, or none — a
 * filter set on another team's board does not follow to this one. */
export function queryOn(state: Pick<ScreenState, "query" | "queryTeam">, teamId: string | null): TaskQuery {
  return state.queryTeam === teamId ? state.query : NO_QUERY;
}

/** Whether J / K walk the list: only over the list, and never while the
 * new-task form is up — its controls have the keys, a field or not. */
export function walksRows(state: Pick<ScreenState, "composing">, view: TrackerView): boolean {
  return view === "list" && !state.composing;
}

/** Whether the stage shows the open task wide: the flag, and a task. */
export function wideView(state: ScreenState, detailOpen: boolean): boolean {
  return state.wide && detailOpen;
}
