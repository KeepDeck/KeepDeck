/**
 * What the new-task form holds and what it hands the owner — mapped here,
 * with the domain's own defaults, so no component re-spells "normal" or
 * turns an empty pick into the pool on its own.
 */
import { DEFAULT_PRIORITY, canHaveEpic, type CreateStatus, type CreateTaskInput, type TaskKind, type TaskPriority } from "../../domain/tasks";

export interface TaskDraft {
  title: string;
  body: string;
  /** A role address, or "" for the pool. */
  assignee: string;
  priority: TaskPriority;
  /** Where it starts: ready to take, or parked in the backlog. */
  status: CreateStatus;
  /** Work, or an epic. */
  kind: TaskKind;
  /** The epic it goes under (a key), or "" for none — work only. */
  parent: string;
}

export const EMPTY_TASK_DRAFT: TaskDraft = {
  title: "",
  body: "",
  assignee: "",
  priority: DEFAULT_PRIORITY,
  status: "todo",
  kind: "task",
  parent: "",
};

/** A draft as the form opens: empty, or in the epic it was opened in. */
export function draftIn(epic: string | null): TaskDraft {
  return epic === null ? EMPTY_TASK_DRAFT : { ...EMPTY_TASK_DRAFT, parent: epic };
}

/** Whether the draft asks for an epic: the domain's answer for its kind
 * (`canHaveEpic`) — work does; an epic goes under none. */
export function takesAnEpic(draft: Pick<TaskDraft, "kind">): boolean {
  return canHaveEpic(draft.kind);
}

/** What a picker's value means: its empty pick is none — no assignee
 * (the pool), no epic. The one reading, for every picker that offers none. */
export function pickedOrNone(value: string): string | null {
  return value === "" ? null : value;
}

/** The assignee a picker's value means: an empty pick is the pool. */
export function assigneeOf(value: string): string | null {
  return pickedOrNone(value);
}

export function taskInputOf(draft: TaskDraft): Omit<CreateTaskInput, "teamId"> {
  return {
    title: draft.title,
    body: draft.body,
    assignee: assigneeOf(draft.assignee),
    priority: draft.priority,
    status: draft.status,
    kind: draft.kind,
    // An epic picked, then the kind turned to epic: an epic goes under none.
    ...(takesAnEpic(draft) && pickedOrNone(draft.parent) !== null ? { parent: draft.parent } : {}),
  };
}
