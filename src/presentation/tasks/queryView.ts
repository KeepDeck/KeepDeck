/**
 * What the tracker shows of a team's tasks, and in what order — ONE set
 * and ONE order for every view of it (the board's columns today, the list
 * beside it), so switching views never reshuffles or loses a task. A
 * filter is a reading posture: held for the dialog's life, never stored.
 */
import { compareQueue, isOpen, type Task, type TaskStatus } from "../../domain/tasks";

export interface TaskQuery {
  /** Only the tasks in `blocked`. */
  blockedOnly: boolean;
  /** Only the tasks carrying this label; null for any. */
  label: string | null;
}

export const NO_QUERY: TaskQuery = { blockedOnly: false, label: null };

export function matchesQuery(task: Task, query: TaskQuery): boolean {
  return (
    (!query.blockedOnly || task.status === "blocked") &&
    (query.label === null || task.labels.includes(query.label))
  );
}

/**
 * The order within one status. Open work keeps queue order (priority, then
 * age), so the first is what would be handed out next; closed work reads
 * newest first, the way a history does.
 */
export function compareInStatus(status: TaskStatus): (a: Task, b: Task) => number {
  return isOpen(status)
    ? compareQueue
    : (a, b) => b.updated - a.updated || a.id.localeCompare(b.id);
}

/** The tasks of one status that the query shows, in their order. */
export function tasksInStatus(tasks: readonly Task[], status: TaskStatus, query: TaskQuery): Task[] {
  return tasks
    .filter((task) => task.status === status && matchesQuery(task, query))
    .sort(compareInStatus(status));
}

export const QUERY_WORDS = {
  blocked: "Blocked",
  label: "Label",
  anyLabel: "All labels",
} as const;

/** The dropdown's value for "any label" — no label is empty. */
export const ANY_LABEL = "";

export interface QueryToolbarView {
  blocked: { label: string; pressed: boolean };
  /** The label picker — absent while the board carries no labels and none
   * is picked: a control with nothing to choose is noise. */
  label: { ariaLabel: string; value: string; options: { value: string; label: string }[] } | null;
}

/** The filters as the toolbar draws them. `vocabulary` is the board's
 * labels (`labelsOf`); a picked label no task carries any more stays an
 * option, so the control still says what narrows the view. */
export function queryToolbarView(query: TaskQuery, vocabulary: readonly string[]): QueryToolbarView {
  const labels =
    query.label !== null && !vocabulary.includes(query.label) ? [...vocabulary, query.label] : vocabulary;
  return {
    blocked: { label: QUERY_WORDS.blocked, pressed: query.blockedOnly },
    label:
      labels.length === 0
        ? null
        : {
            ariaLabel: QUERY_WORDS.label,
            value: query.label ?? ANY_LABEL,
            options: [
              { value: ANY_LABEL, label: QUERY_WORDS.anyLabel },
              ...labels.map((label) => ({ value: label, label })),
            ],
          },
  };
}

/** The query after a pick in the label control. */
export function withLabel(query: TaskQuery, value: string): TaskQuery {
  return { ...query, label: value === ANY_LABEL ? null : value };
}
