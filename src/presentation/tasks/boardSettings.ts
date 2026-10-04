/**
 * The Tasks dialog's stored posture (`Settings.tasksBoard`) as the screen
 * reads it and as the person's acts change it: the view, and the list's
 * folded groups. Every change answers the whole new posture, for the
 * settings owner to keep — the dialog holds none of it itself.
 */
import { inLadderOrder, type TaskStatus } from "../../domain/tasks";
import type { TasksBoardSettings, TasksView } from "../../domain/settings";

/** The list's folded groups, as a set to ask. */
export function boardFolded(board: TasksBoardSettings): ReadonlySet<TaskStatus> {
  return new Set(board.list.folded);
}

/** The posture with `view` picked. */
export function boardWithView(board: TasksBoardSettings, view: TasksView): TasksBoardSettings {
  return { ...board, view };
}

/** The posture after a heading's toggle: the group folds, or unfolds. */
export function boardWithFold(board: TasksBoardSettings, status: TaskStatus): TasksBoardSettings {
  const folded = board.list.folded.includes(status)
    ? board.list.folded.filter((other) => other !== status)
    : inLadderOrder([...board.list.folded, status]);
  return { ...board, list: { ...board.list, folded } };
}

/** The posture after a task's move by a drop landed: in the list, the
 * folded group it went into opens, so the row is seen where it went; a
 * drop on the board leaves the list's folds alone. Null: nothing changes. */
export function boardAfterDrop(board: TasksBoardSettings, status: TaskStatus, view: TasksView): TasksBoardSettings | null {
  if (view !== "list" || !board.list.folded.includes(status)) return null;
  return boardWithFold(board, status);
}
