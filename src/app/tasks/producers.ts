/**
 * The task board's notification producer: a task an AGENT put on the
 * board, and every move of a task along the ladder (the user's decision —
 * a board the person cannot see changing is one they cannot follow; the
 * user's own creations are left out, they made them in front of the
 * board). One slot per task: a task that flaps holds one line in the
 * center, not a column.
 */
import { findTeam, type Workspace } from "../../domain/deck";
import type { NotificationSeverity } from "../../domain/notifications";
import type { TaskStatus } from "../../domain/tasks";
import { notify } from "../notificationCenter";
import type { TaskEvent } from "./tasksService";

export interface TaskProducerDeps {
  workspaces(): readonly Workspace[];
}

export function announceTask(event: TaskEvent, deps: TaskProducerDeps): void {
  // A creation by the user is their own act; the board is right in front
  // of them.
  if (event.kind === "created" && event.actor.kind !== "agent") return;
  const workspace = deps.workspaces().find((candidate) => candidate.id === event.workspaceId);
  // No workspace, no board to open on a click: say nothing.
  if (!workspace) return;
  const { task } = event;
  const team = findTeam(workspace, task.teamId)?.name ?? task.teamId;
  const words = wording(event, team);
  notify({
    ...words,
    source: { type: "tasks", workspace: { id: workspace.id, instance: workspace.instance }, taskId: task.id },
    tag: `tasks:${workspace.id}:${task.id}`,
  });
}

function wording(
  event: TaskEvent,
  team: string,
): { title: string; body: string; severity: NotificationSeverity } {
  const { task } = event;
  switch (event.kind) {
    case "created": {
      const by = event.actor.kind === "agent" ? (event.actor.role ?? "an agent") : "you";
      return {
        title: `${by} put a task on ${team}'s board`,
        body: `${task.id} · ${task.title}`,
        severity: "info",
      };
    }
    case "moved":
      return {
        title: moveTitle(task.id, event.from, task.status),
        body: `${task.title} · ${task.assignee ?? "unassigned"} · ${team}`,
        severity: task.status === "blocked" ? "warning" : "info",
      };
  }
}

/** What a move is called, from where it stood to where it went. */
function moveTitle(id: string, from: TaskStatus, to: TaskStatus): string {
  switch (to) {
    case "todo":
      return `${id} reopened`;
    case "in-progress":
      return from === "todo" ? `${id} started` : `${id} back in progress`;
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
