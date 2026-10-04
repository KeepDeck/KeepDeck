/**
 * The task board's notification producer: a task an AGENT put on the
 * board, and every move of a task along the ladder (the user's decision —
 * a board the person cannot see changing is one they cannot follow; the
 * user's own creations are left out, they made them in front of the
 * board). One slot per task: a task that flaps holds one line in the
 * center, not a column.
 */
import { findTeam, type Workspace } from "../../domain/deck";
import {
  createdWords,
  movedWords,
  transferredWords,
  type TaskNotificationWords,
} from "../../presentation/tasks/notificationWords";
import { notify } from "../notificationCenter";
import type { TaskEvent } from "./tasksService";

export interface TaskProducerDeps {
  workspaces(): readonly Workspace[];
}

export function announceTask(event: TaskEvent, deps: TaskProducerDeps): void {
  // A creation or a transfer by the user is their own act; the board is
  // right in front of them.
  if ((event.kind === "created" || event.kind === "transferred") && event.actor.kind !== "agent") return;
  const workspace = deps.workspaces().find((candidate) => candidate.id === event.workspaceId);
  // No workspace, no board to open on a click: say nothing.
  if (!workspace) return;
  const { task } = event;
  const team = findTeam(workspace, task.teamId)?.name ?? task.teamId;
  const words = wording(event, team);
  notify({
    ...words,
    source: { type: "tasks", workspace: { id: workspace.id, instance: workspace.instance }, taskId: task.id },
    // Keyed on the uid: one slot per task whatever it is called.
    tag: `tasks:${workspace.id}:${task.uid}`,
  });
}

function wording(event: TaskEvent, team: string): TaskNotificationWords {
  const by = event.actor.kind === "agent" ? event.actor.role : null;
  switch (event.kind) {
    case "created":
      return createdWords(event.task, by, team, event.copiedFrom);
    case "moved":
      return movedWords(event.task, event.from, team);
    case "transferred":
      return transferredWords(event.task, by, event.fromTeam, team);
  }
}
