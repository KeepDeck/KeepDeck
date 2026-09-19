/**
 * The words the task surfaces share: what a status is called, how a
 * person is named, which hue a status wears. One home, so the board, the
 * queues, the detail and the card footer cannot disagree.
 */
import { USER_NAME, type TaskPriority, type TaskStatus } from "../../domain/tasks";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  doing: "Doing",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
  dropped: "Dropped",
};

/** The status ladder's four hues plus none — the SAME names status.css
 * paints panes and cards with, so a task in review wears the waiting hue
 * a pane waiting for the user wears. */
export type StatusTone = "working" | "waiting" | "failed" | "done" | "none";

export function statusTone(status: TaskStatus): StatusTone {
  switch (status) {
    case "doing":
      return "working";
    case "review":
      return "waiting";
    case "blocked":
      return "failed";
    case "done":
      return "done";
    case "todo":
    case "dropped":
      return "none";
  }
}

/** The domain stores `user`; a person reading their own name reads "you". */
export function personName(name: string): string {
  return name === USER_NAME ? "you" : name;
}

/** Normal is the silent default; only the ends of the scale are marked. */
export function priorityMark(priority: TaskPriority): string | null {
  return priority === "normal" ? null : priority.toUpperCase();
}

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: "High",
  normal: "Normal",
  low: "Low",
};

/** What the pool is called wherever an empty assignee is shown. */
export const POOL_LABEL = "pool";
