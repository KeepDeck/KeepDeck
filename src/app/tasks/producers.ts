/**
 * The task board's notification producer: the three events a human is
 * told about — a task an AGENT put on the board, a task stuck in
 * `blocked`, a task accepted into `done` — and nothing else (the user's
 * decision: not review, not in progress, not the user's own creations, which
 * they can see). One slot per task: a task that flaps holds one line in
 * the center, not a column.
 */
import { findTeam, type Workspace } from "../../domain/deck";
import type { NotificationSeverity } from "../../domain/notifications";
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
    case "blocked":
      return {
        title: `${task.id} is blocked`,
        body: `${task.title} · ${task.assignee ?? "unassigned"} · ${team}`,
        severity: "warning",
      };
    case "done":
      return {
        title: `${task.id} accepted`,
        body: `${task.title} · ${team}`,
        severity: "info",
      };
  }
}
