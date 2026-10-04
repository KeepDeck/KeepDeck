/**
 * What the new-task form holds and what it hands the owner — mapped here,
 * with the domain's own defaults, so no component re-spells "normal" or
 * turns an empty pick into the pool on its own.
 */
import { DEFAULT_PRIORITY, type CreateStatus, type CreateTaskInput, type TaskPriority } from "../../domain/tasks";

export interface TaskDraft {
  title: string;
  body: string;
  /** A role address, or "" for the pool. */
  assignee: string;
  priority: TaskPriority;
  /** Where it starts: ready to take, or parked in the backlog. */
  status: CreateStatus;
}

export const EMPTY_TASK_DRAFT: TaskDraft = { title: "", body: "", assignee: "", priority: DEFAULT_PRIORITY, status: "todo" };

/** The assignee a picker's value means: an empty pick is the pool. */
export function assigneeOf(value: string): string | null {
  return value === "" ? null : value;
}

export function taskInputOf(draft: TaskDraft): Omit<CreateTaskInput, "teamId"> {
  return { title: draft.title, body: draft.body, assignee: assigneeOf(draft.assignee), priority: draft.priority, status: draft.status };
}
