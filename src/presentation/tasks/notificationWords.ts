/**
 * What the notification center says about the board: a task put on it by
 * an agent, and a task's move along the ladder. The words for a status
 * live here, beside STATUS_LABEL, so a new rung gets its words in one
 * place; the producer (app/tasks/producers) only delivers them.
 */
import type { NotificationSeverity } from "../../domain/notifications";
import type { Task, TaskStatus } from "../../domain/tasks";

export interface TaskNotificationWords {
  title: string;
  body: string;
  severity: NotificationSeverity;
}

/** A task an agent put on the board — parked, if it went to the backlog,
 * so the center says it is not one to take. `by` is the role, or null for
 * an agent with none. */
export function createdWords(
  task: Pick<Task, "id" | "title" | "status">,
  by: string | null,
  team: string,
  /** The task this one is a copy of, when it is one. */
  copiedFrom?: string,
): TaskNotificationWords {
  const who = by ?? "an agent";
  const what = copiedFrom === undefined ? "a task" : `a copy of ${copiedFrom}`;
  return {
    title: task.status === "backlog" ? `${who} parked ${what} in ${team}'s backlog` : `${who} put ${what} on ${team}'s board`,
    body: `${task.id} · ${task.title}`,
    severity: "info",
  };
}

/** A task's move, from `from` to where it stands now. */
export function movedWords(
  task: Pick<Task, "id" | "title" | "status" | "assignee">,
  from: TaskStatus,
  team: string,
): TaskNotificationWords {
  return {
    title: moveTitle(task.id, from, task.status),
    body: `${task.title} · ${task.assignee ?? "unassigned"} · ${team}`,
    severity: task.status === "blocked" ? "warning" : "info",
  };
}

function moveTitle(id: string, from: TaskStatus, to: TaskStatus): string {
  switch (to) {
    case "backlog":
      return `${id} moved to the backlog`;
    case "todo":
      return from === "backlog" ? `${id} is ready to start` : `${id} reopened`;
    case "in-progress":
      // From the ladder's start — waiting, or parked — it started; from
      // anywhere further on, it came back.
      return from === "todo" || from === "backlog" ? `${id} started` : `${id} back in progress`;
    case "blocked":
      return `${id} is blocked`;
    case "review":
      return `${id} is ready for review`;
    case "done":
      return `${id} accepted`;
    case "cancelled":
      return `${id} cancelled`;
  }
}
