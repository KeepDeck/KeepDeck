import { formatAge } from "../../domain/usage";
import { openBlockersOf, type Task, type TaskBoard } from "../../domain/tasks";
import { POOL_LABEL, priorityMark, statusTone, type StatusTone } from "./words";

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
}

/** A card's identity in its column's windowed list — the task's id, never
 * its index: a move reorders the columns, and an index key would hand one
 * card's measured height to whatever slid into its place. */
export function taskCardKey(card: Pick<TaskCardView, "id">): string {
  return card.id;
}

/** The first paint's guess at a card and the gap under it, in pixels;
 * measurement corrects it the moment a card reports its box. The tall
 * card's — a meta line wrapped, a blocker line under it — since a guess
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
  };
}
