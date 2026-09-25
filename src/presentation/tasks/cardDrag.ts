/**
 * Dragging a card between columns, as a machine with no DOM in it: what
 * a press, a move and a release DO. The hook feeds it pointer facts and
 * applies what it answers; the columns read `dropStateOf` for their look.
 * Every threshold and every rule about a drag lives here and is tested
 * without a browser.
 */
import type { TaskStatus } from "../../domain/tasks";

/** How far a pressed card travels before it is a drag and not a click. */
export const DRAG_THRESHOLD_PX = 6;
/** The click the browser fires after a release must not open the card
 * that was just dropped; this is how long such a click is disbelieved. */
export const CLICK_AFTER_DRAG_MS = 250;

/** Where the press landed on the card, and how wide the card was: the
 * ghost is drawn at exactly that size, under exactly that point. */
export interface CardGrip {
  width: number;
  offsetX: number;
  offsetY: number;
}

export type DragState =
  | { kind: "idle" }
  /** Pressed, not yet travelled: a click until proven otherwise. */
  | { kind: "armed"; id: string; x: number; y: number; grip: CardGrip }
  | {
      kind: "dragging";
      id: string;
      x: number;
      y: number;
      grip: CardGrip;
      /** Where it may land — judged once, when the drag began. */
      targets: ReadonlySet<TaskStatus>;
    };

export const IDLE: DragState = { kind: "idle" };

export function armCard(id: string, x: number, y: number, grip: CardGrip): DragState {
  return { kind: "armed", id, x, y, grip };
}

/**
 * The pointer moved. An armed card becomes a drag past the threshold —
 * `targetsOf` answers where it may land, or null when the card is gone —
 * and a drag follows the pointer.
 */
export function moveCard(
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
 * The pointer was released — over a column, or over nothing. A drag over
 * a target is a move; anything else is nothing. `dragged` says whether a
 * drag (not a mere press) just ended, for the click that follows.
 */
export function releaseCard(
  state: DragState,
  over: TaskStatus | null,
): { state: DragState; move: { id: string; to: TaskStatus } | null; dragged: boolean } {
  if (state.kind !== "dragging") return { state: IDLE, move: null, dragged: false };
  const move = over !== null && state.targets.has(over) ? { id: state.id, to: over } : null;
  return { state: IDLE, move, dragged: true };
}

/** What a column is to the drag in flight: a target, the target under
 * the pointer, not a target — or nothing while no card is in flight. */
export function dropStateOf(
  status: TaskStatus,
  state: DragState,
  hover: TaskStatus | null,
): "ok" | "over" | "no" | null {
  if (state.kind !== "dragging") return null;
  if (!state.targets.has(status)) return "no";
  return hover === status ? "over" : "ok";
}

/** What a card on the board is right now: the one open in the panel, the
 * one in flight. */
export function cardStateOf(
  id: string,
  selectedId: string | null,
  state: DragState,
): { selected: boolean; dragging: boolean } {
  return { selected: id === selectedId, dragging: state.kind === "dragging" && state.id === id };
}

/** A column's classes: lit by its part in the drag in flight. */
export function columnClassName(
  status: TaskStatus,
  state: DragState,
  hover: TaskStatus | null,
): string {
  const drop = dropStateOf(status, state, hover);
  return drop ? `tasks__column tasks__column--drop-${drop}` : "tasks__column";
}

/** Whether a click arriving `now` is the tail of a drag that ended at
 * `dragEndedAt`, and must not select anything. */
export function clickDisbelieved(dragEndedAt: number | null, now: number): boolean {
  return dragEndedAt !== null && now - dragEndedAt < CLICK_AFTER_DRAG_MS;
}

/** Where the ghost is drawn: the card's box, under the grip point. */
export function ghostBox(state: DragState): { left: number; top: number; width: number } | null {
  if (state.kind !== "dragging") return null;
  return { left: state.x - state.grip.offsetX, top: state.y - state.grip.offsetY, width: state.grip.width };
}
