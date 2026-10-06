import { formatAge } from "../../domain/usage";
import { blockerResolved, blockersOf, type Task, type TaskBoard, type TaskStatus } from "../../domain/tasks";
import type { StatusRingProps } from "@keepdeck/ui-kit/StatusRing";
import { POOL_LABEL, STATUS_LABEL, priorityMark, statusTone, type StatusTone } from "./words";
import { taskOnScreen, type DragState } from "./rowDrag";

/** One task as a list row says it, in columns: priority, status, id,
 * title, labels, what holds it, who has it, how long since it moved. */
export interface TaskRowView {
  id: string;
  title: string;
  priority: string | null;
  tone: StatusTone;
  /** Struck through and dimmed: taken off the board without being done. */
  cancelled: boolean;
  /** The task's labels, as words — no colour: colour is state. */
  labels: readonly string[];
  assignee: string;
  age: string;
  /** The status as a small ring, filled as far as the ladder has come. */
  ring: StatusRingProps;
  /** Every blocker named, each as a chip: standing (the failed hue) or
   * resolved (struck — it holds nothing). */
  blockerChips: BlockerChip[];
}

/** One blocker as a chip: where it stands, and whether it still holds. */
export interface BlockerChip {
  id: string;
  /** `task-1 · in progress`. */
  text: string;
  resolved: boolean;
  className: string;
}

/** THE blocker chip — a row's, the open task's — for a blocker
 * on this board (one that is not has no key here to show; task-224). A
 * resolved one (done, cancelled) holds nothing and is struck through. */
export function blockerChip(blocker: Task): BlockerChip {
  const resolved = blockerResolved(blocker.status);
  return {
    id: blocker.id,
    text: `${blocker.id} · ${STATUS_LABEL[blocker.status].toLowerCase()}`,
    resolved,
    className: resolved ? "kd-tag kd-tag--outline tasks__tag--resolved" : "kd-tag kd-tag--outline tasks__tag--blocking",
  };
}

/** How far along each status stands on the ladder, as a ring's fill. */
const LADDER_FILL: Record<TaskStatus, number> = {
  backlog: 0,
  todo: 0,
  blocked: 0,
  "in-progress": 50,
  review: 75,
  done: 100,
  cancelled: 100,
};

/** A status as the tracker's ring (ui-kit StatusRing): filled by its place
 * on the ladder, in the status hue `statusTone` names — cancelled a grey
 * disc, blocked barred. */
export function statusRing(status: TaskStatus): StatusRingProps {
  return {
    fill: LADDER_FILL[status],
    tone: statusTone(status),
    barred: status === "blocked",
    dashed: status === "backlog",
    label: STATUS_LABEL[status],
  };
}

/** A status's ring beside its own word — a heading, a picker's option,
 * the open task's meta line: the word names it, the ring only pictures. */
export function statusMark(status: TaskStatus): StatusRingProps {
  return { ...statusRing(status), decorative: true };
}

/** The row of the task in flight, read from the board — not from what the
 * list shows, which a move by someone else (into a folded group, out of
 * the filter) may take it out of mid-drag. Null while nothing flies. */
export function rowInFlight(
  drag: DragState,
  board: TaskBoard | null,
  teamId: string | null,
  now: number,
): TaskRowView | null {
  if (drag.kind !== "dragging" || board === null) return null;
  const task = taskOnScreen(board, drag.id, teamId);
  return task ? taskRowView(task, board, now) : null;
}

export function taskRowView(task: Task, board: TaskBoard, now: number): TaskRowView {
  return {
    id: task.id,
    title: task.title,
    priority: priorityMark(task.priority),
    tone: statusTone(task.status),
    cancelled: task.status === "cancelled",
    labels: task.labels,
    assignee: task.assignee ?? POOL_LABEL,
    age: formatAge(task.updated, now),
    ring: statusRing(task.status),
    blockerChips: blockersOf(task, board).map(blockerChip),
  };
}
