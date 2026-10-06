/**
 * What the tracker shows of a team's tasks, and in what order — ONE set
 * and ONE order for the list. A filter is a reading posture: held for the
 * dialog's life, never stored.
 */
import { compareQueue, isOpen, type Task, type TaskStatus } from "../../domain/tasks";

export interface TaskQuery {
  /** Only the tasks carrying this label; null for any. */
  label: string | null;
}

export const NO_QUERY: TaskQuery = { label: null };

export function matchesQuery(task: Task, query: TaskQuery): boolean {
  return query.label === null || task.labels.includes(query.label);
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

/** Whether the query narrows to nothing: something narrows, and no task
 * of the team gets through — said in words, not left as six zeros. */
export function findsNothing(tasks: readonly Task[], query: TaskQuery): boolean {
  const narrows = query.label !== null;
  return narrows && !tasks.some((task) => matchesQuery(task, query));
}

export const QUERY_WORDS = {
  nothing: { title: "No task matches", hint: "Clear the filter in the toolbar to see every task" },
  label: (label: string) => `label: ${label}`,
  clearLabel: (label: string) => `Show every label, not only ${label}`,
} as const;

export interface QueryToolbarView {
  /** The label narrowing the view, as a chip that clears it — null while
   * none does. A label is picked by clicking it on a row. */
  label: { text: string; clear: string } | null;
}

/** The filters as the toolbar draws them. */
export function queryToolbarView(query: TaskQuery): QueryToolbarView {
  return {
    label: query.label === null ? null : { text: `${QUERY_WORDS.label(query.label)} ✕`, clear: QUERY_WORDS.clearLabel(query.label) },
  };
}

/** The query after a label is clicked: that label — or none, when it is
 * the one already narrowing the view. */
export function withLabel(query: TaskQuery, label: string | null): TaskQuery {
  return { ...query, label: label === query.label ? null : label };
}
