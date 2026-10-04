/**
 * The words the task surfaces share: what a status is called, how a
 * person is named, which hue a status wears. One home, so the board, the
 * detail and the card footer cannot disagree.
 */
import type { TasksView } from "../../domain/settings";
import {
  PRE_RELATIONS_COPY,
  TASK_PRIORITIES,
  USER_NAME,
  capOf,
  keptLength,
  type CappedField,
  type TaskPriority,
  type TaskStatus,
} from "../../domain/tasks";

/** The tracker's two views, as the toolbar's choice row names them. */
export const VIEW_WORDS = {
  choice: "View",
  label: { list: "List", board: "Board" } as Record<TasksView, string>,
} as const;

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
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
    case "backlog":
    case "todo":
    case "cancelled":
      return "none";
  }
}

/** A capped field's count under it — what is taken of how much there is
 * (`37/120`), in the domain's own measure (`keptLength`: as it would be
 * kept, in characters), and marked once it is past the cap. The field
 * itself takes any text: the count says it is too long, and sending it is
 * refused, rather than the field silently cutting what was typed. */
export function fieldCount(field: CappedField, text: string): { text: string; className: string } {
  const length = keptLength(field, text);
  const max = capOf(field);
  return {
    text: `${length}/${max}`,
    className: length > max ? "tasks__count tasks__count--over" : "tasks__count",
  };
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
export function priorityChoices(): (ChoiceView & { value: TaskPriority })[] {
  return TASK_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABEL[value] }));
}

/** What the dialog says over a board whose disk lags its memory. */
export function unsavedBanner(error: string, upgrade = false): string {
  // A board read in an older format lags because its upgrade has not
  // landed — maybe before the person changed anything at all.
  if (upgrade) {
    return `The board's upgrade to linked tasks is not saved yet — ${error}. The old file is left as it is until a copy of it is kept as board.${PRE_RELATIONS_COPY}.json; the board retries on its own.`;
  }
  return `Changes not saved yet — ${error}. The board keeps them and retries on its own.`;
}

/** What an empty assignee is called wherever one is shown — the plain
 * word, not the board's internal "pool". */
export const POOL_LABEL = "unassigned";

/** The assignee choice that leaves a task to whoever takes it — the same
 * line in the new-task form and in the task panel. */
export const POOL_CHOICE: ChoiceView = { value: "", label: POOL_LABEL };

/** A task's fields, named once for every surface that edits them. */
export const FIELD_WORDS = {
  title: "Title",
  brief: "Brief",
  status: "Status",
  priority: "Priority",
  assignee: "Assignee",
} as const;

/** The new-task button's label — and how a hint that points at it names it. */
export const NEW_TASK_LABEL = "+ Task";

/** The order the board reads in, left to right — and the order every
 * status list follows. Blocked stands first: it is what waits on a
 * person, and a board is read from the left. Then the ladder in order:
 * parked work, then what may be started, and on. */
export const BOARD_ORDER: readonly TaskStatus[] = [
  "blocked",
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
  "cancelled",
];

/** The blocker links that keep a task on its team, as the person reads
 * them: what it waits on, then what waits on it. One wording for the
 * detail's menu and the agents' refusal. */
export function blockerLinkWords(links: { blockers: readonly string[]; dependants: readonly string[] }): string[] {
  return [...links.blockers.map((id) => `it waits on ${id}`), ...links.dependants.map((id) => `${id} waits on it`)];
}
