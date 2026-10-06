/**
 * Dragging a task between the list's status groups, as a machine with no
 * DOM in it: what a press, a move and a release DO. The hook feeds it
 * pointer facts and applies what it answers; the groups read
 * `dropStateOf` for their look.
 * Every threshold and every rule about a drag lives here and is tested
 * without a browser.
 */
import { findTask, type Task, type TaskBoard, type TaskStatus } from "../../domain/tasks";

/** How far a pressed row travels before it is a drag and not a click. */
export const DRAG_THRESHOLD_PX = 6;
/** The click the browser fires after a release must not open the task
 * that was just dropped; this is how long such a click is disbelieved. */
export const CLICK_AFTER_DRAG_MS = 250;

/** Where the press landed on the row, and how wide the row was: the
 * ghost is drawn at exactly that size, under exactly that point. */
export interface RowGrip {
  width: number;
  offsetX: number;
  offsetY: number;
}

export type DragState =
  | { kind: "idle" }
  /** Pressed, not yet travelled: a click until proven otherwise. */
  | { kind: "armed"; id: string; x: number; y: number; grip: RowGrip }
  | {
      kind: "dragging";
      id: string;
      x: number;
      y: number;
      grip: RowGrip;
      /** Where it may land — judged once, when the drag began. */
      targets: ReadonlySet<TaskStatus>;
    };

export const IDLE: DragState = { kind: "idle" };

/** A task as the board on screen holds it: on the board, and on the team
 * shown — deleted, or moved to another team, it is not there. The one rule
 * for the task open (its panel) and the task in flight (a drag carries a
 * task only while it is still there, and ends when it is not). */
export function taskOnScreen(board: TaskBoard | null, id: string | null, teamId: string | null): Task | null {
  if (id === null) return null;
  const task = board ? findTask(board, id) : undefined;
  return task && task.teamId === teamId ? task : null;
}

/** A drag whose task left the board on screen mid-flight ends (IDLE);
 * null while it still has one, or nothing flies. */
export function dragOutlived(state: DragState, carried: unknown): DragState | null {
  return state.kind === "dragging" && carried === null ? IDLE : null;
}

/** Escape while a row is pressed or in flight puts it back — the key
 * peels the drag before any layer under it. Null when there is no drag:
 * the key is the screen's to read. */
export function escapeDrag(state: DragState): DragState | null {
  return state.kind === "idle" ? null : IDLE;
}

export function armRow(id: string, x: number, y: number, grip: RowGrip): DragState {
  return { kind: "armed", id, x, y, grip };
}

/**
 * The pointer moved. An armed row becomes a drag past the threshold —
 * `targetsOf` answers where it may land, or null when the task is gone —
 * and a drag follows the pointer.
 */
export function moveRow(
  state: DragState,
  x: number,
  y: number,
  targetsOf: (id: string) => ReadonlySet<TaskStatus> | null,
): DragState {
  if (state.kind === "dragging") return { ...state, x, y };
  if (state.kind !== "armed") return state;
  if (Math.hypot(x - state.x, y - state.y) < DRAG_THRESHOLD_PX) return state;
  const targets = targetsOf(state.id);
  if (targets === null) return IDLE;
  return { kind: "dragging", id: state.id, x, y, grip: state.grip, targets };
}

/**
 * The pointer was released — over a status group, or over nothing. A drag over
 * a target is a move; anything else is nothing. `dragged` says whether a
 * drag (not a mere press) just ended, for the click that follows.
 */
export function releaseRow(
  state: DragState,
  over: TaskStatus | null,
): { state: DragState; move: { id: string; to: TaskStatus } | null; dragged: boolean } {
  if (state.kind !== "dragging") return { state: IDLE, move: null, dragged: false };
  const move = over !== null && state.targets.has(over) ? { id: state.id, to: over } : null;
  return { state: IDLE, move, dragged: true };
}

/** What a status group is to the drag in flight: a target, the target
 * under the pointer, not a target — or nothing while no task is in flight. */
export function dropStateOf(
  status: TaskStatus,
  state: DragState,
  hover: TaskStatus | null,
): "ok" | "over" | "no" | null {
  if (state.kind !== "dragging") return null;
  if (!state.targets.has(status)) return "no";
  return hover === status ? "over" : "ok";
}

/** Whether a click arriving `now` is the tail of a drag that ended at
 * `dragEndedAt`, and must not select anything. */
export function clickDisbelieved(dragEndedAt: number | null, now: number): boolean {
  return dragEndedAt !== null && now - dragEndedAt < CLICK_AFTER_DRAG_MS;
}

/** Where the ghost is drawn: the row's box, under the grip point. */
export function ghostBox(state: DragState): { left: number; top: number; width: number } | null {
  if (state.kind !== "dragging") return null;
  return { left: state.x - state.grip.offsetX, top: state.y - state.grip.offsetY, width: state.grip.width };
}
