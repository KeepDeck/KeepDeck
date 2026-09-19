/**
 * The words the task surfaces share: what a status is called, how a
 * person is named, which hue a status wears. One home, so the board, the
 * queues, the detail and the card footer cannot disagree.
 */
import { TASK_PRIORITIES, USER_NAME, type TaskPriority, type TaskStatus } from "../../domain/tasks";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  "in-progress": "In progress",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

/** The status ladder's four hues plus none — the SAME names status.css
 * paints panes and cards with, so a task in review wears the waiting hue
 * a pane waiting for the user wears. */
export type StatusTone = "working" | "waiting" | "failed" | "done" | "none";

export function statusTone(status: TaskStatus): StatusTone {
  switch (status) {
    case "in-progress":
      return "working";
    case "review":
      return "waiting";
    case "blocked":
      return "failed";
    case "done":
      return "done";
    case "todo":
    case "cancelled":
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

/** One option a picker offers: the value it sends, the words it shows. */
export interface ChoiceView {
  value: string;
  label: string;
}

/** The priority picker's options — the ONE list both forms offer. */
export function priorityChoices(): ChoiceView[] {
  return TASK_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABEL[value] }));
}

/** What the dialog says over a board whose disk lags its memory. */
export function unsavedBanner(error: string): string {
  return `Changes not saved yet — ${error}. The board keeps them and retries on its own.`;
}

/** What the pool is called wherever an empty assignee is shown. */
export const POOL_LABEL = "pool";

/** The order the board reads in, left to right — and the order every
 * status list follows. Blocked stands first: it is what waits on a
 * person, and a board is read from the left. */
export const BOARD_ORDER: readonly TaskStatus[] = [
  "blocked",
  "todo",
  "in-progress",
  "review",
  "done",
  "cancelled",
];
