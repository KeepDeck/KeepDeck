import { formatAge } from "../../domain/usage";
import { blockerResolved, findTask, openBlockersOf, type Task, type TaskBoard, type TaskStatus } from "../../domain/tasks";
import type { StatusRingProps } from "@keepdeck/ui-kit/StatusRing";
import { POOL_LABEL, STATUS_LABEL, priorityMark, statusTone, type StatusTone } from "./words";

/** One task as a card says it: title, identity line, the two marks that
 * matter at a glance (priority, an unmet blocker). */
export interface TaskCardView {
  id: string;
  title: string;
  /** `task-3 · impl-1 · 12m ago` — id first, the durable half. */
  meta: string;
  priority: string | null;
  /** `blocked by task-1 · task-2`, or null when nothing holds it. */
  blockedBy: string | null;
  tone: StatusTone;
  /** Struck through and dimmed: taken off the board without being done. */
  cancelled: boolean;
  /** The task's labels, as words — no colour: colour is state. */
  labels: readonly string[];
  /** The parts of `meta`, for a row that lays them out in columns. */
  assignee: string;
  /** The assignee's mark: `A2` for analyst-2, `LE` for the lead; none for
   * the pool — nobody to mark. */
  initials: string | null;
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
  /** `task-1 · in progress`, or `· gone` for an id the board lost. */
  text: string;
  resolved: boolean;
  className: string;
}

/** THE blocker chip — a row's, a card's, the open task's. A resolved one
 * (done, cancelled, gone) holds nothing and is struck through. */
export function blockerChip(board: TaskBoard, id: string): BlockerChip {
  const blocker = findTask(board, id);
  const resolved = blocker === undefined || blockerResolved(blocker.status);
  return {
    id,
    text: `${id} · ${blocker ? STATUS_LABEL[blocker.status].toLowerCase() : "gone"}`,
    resolved,
    className: resolved ? "kd-tag kd-tag--outline tasks__tag--resolved" : "kd-tag kd-tag--outline tasks__tag--blocking",
  };
}

/** A role's mark in two letters: its kind's first letter and its number
 * (`analyst-2` → `A2`), the two first letters otherwise (`lead` → `LE`). */
export function roleInitials(role: string | null): string | null {
  if (role === null) return null;
  const numbered = /^([a-z])[a-z]*-(\d+)$/i.exec(role);
  return (numbered ? numbered[1] + numbered[2] : role.slice(0, 2)).toUpperCase();
}

/** How far along each status stands on the ladder, as a ring's fill. */
const LADDER_FILL: Record<TaskStatus, number> = {
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
    label: STATUS_LABEL[status],
  };
}

/** A card's identity in its column's windowed list — the task's id, never
 * its index: a move reorders the columns, and an index key would hand one
 * card's measured height to whatever slid into its place. */
export function taskCardKey(card: Pick<TaskCardView, "id">): string {
  return card.id;
}

/** The first paint's guess at a card and the gap under it, in pixels;
 * measurement corrects it the moment a card reports its box. The tall
 * card's — a blocked-by line under the meta, wrapped when several
 * blockers stand; the title and the meta never wrap — since a guess
 * that overshoots only shrinks the scrollbar as cards land, where one that
 * undershoots makes it jump away under the pointer. */
export const TASK_CARD_ESTIMATE_PX = 90;

/** The card's classes: its tone, and whether it is cancelled, the card in
 * flight, or one a press can pick up. */
export function taskCardClassName(
  card: Pick<TaskCardView, "tone" | "cancelled">,
  state: { dragging: boolean; grabbable: boolean },
): string {
  return [
    "tasks__card",
    `tasks__card--${card.tone}`,
    card.cancelled && "tasks__card--cancelled",
    state.dragging && "tasks__card--dragging",
    state.grabbable && "tasks__card--grabbable",
  ]
    .filter(Boolean)
    .join(" ");
}

export function taskCardView(task: Task, board: TaskBoard, now: number): TaskCardView {
  const open = openBlockersOf(task, board);
  return {
    id: task.id,
    title: task.title,
    meta: [task.id, task.assignee ?? POOL_LABEL, formatAge(task.updated, now)].join(" · "),
    priority: priorityMark(task.priority),
    blockedBy: open.length === 0 ? null : `blocked by ${open.join(" · ")}`,
    tone: statusTone(task.status),
    cancelled: task.status === "cancelled",
    labels: task.labels,
    assignee: task.assignee ?? POOL_LABEL,
    initials: roleInitials(task.assignee),
    age: formatAge(task.updated, now),
    ring: statusRing(task.status),
    blockerChips: task.blockedBy.map((id) => blockerChip(board, id)),
  };
}
