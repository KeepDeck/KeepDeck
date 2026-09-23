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
