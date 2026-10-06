import {
  CREATE_STATUSES,
  TASK_CAPS,
  TASK_KINDS,
  parentProblem,
  tasksOfTeam,
  type CreateStatus,
  type TaskBoard,
  type TaskKind,
  type TaskPriority,
} from "../../domain/tasks";
import { draftIn, type TaskDraft } from "./formDraft";
import { POOL_CHOICE, STATUS_LABEL, priorityChoices, type ChoiceView } from "./words";

export interface NewTaskFormView {
  assigneeOptions: ChoiceView[];
  priorityOptions: (ChoiceView & { value: TaskPriority })[];
  /** Where it starts: To do, or the backlog. */
  statusOptions: (ChoiceView & { value: CreateStatus })[];
  /** Under the assignee: the addresses teammates use, or that nobody is
   * here yet. */
  addressHint: string;
  bodyPlaceholder: string;
  /** Work or an epic. */
  kindOptions: (ChoiceView & { value: TaskKind })[];
  /** None, then the team's epics new work may go under (the family rule's
   * own answer for a task made now). */
  epicOptions: ChoiceView[];
  /** What the form holds as it opens. */
  draft: TaskDraft;
}

const KIND_LABEL: Record<TaskKind, string> = { task: "Task", epic: "Epic" };

/** The form's own words; the fields' names are FIELD_WORDS. */
export const NEW_TASK_WORDS = {
  panel: "New task",
  intro: "Put work on the team's board — assign it now or leave it unassigned for whoever takes it.",
  cancel: "Cancel",
  create: "Create task",
  kind: "Type",
  epic: "Epic",
  noEpic: "No epic",
} as const;


export function newTaskFormView(
  roster: readonly string[],
  /** The board and team the form makes the task on — where its epics are. */
  board: TaskBoard | null,
  teamId: string | null,
  /** The epic the form was opened in, or null. */
  epic: string | null,
): NewTaskFormView {
  const epics =
    board === null || teamId === null
      ? []
      : tasksOfTeam(board, teamId).filter((task) => parentProblem({ kind: "task", teamId, status: "todo" }, task.id, board) === null);
  return {
    kindOptions: TASK_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] })),
    epicOptions: [{ value: "", label: NEW_TASK_WORDS.noEpic }, ...epics.map((task) => ({ value: task.id, label: `${task.id} · ${task.title}` }))],
    draft: draftIn(epic),
    assigneeOptions: [
      POOL_CHOICE,
      ...roster.map((role) => ({ value: role, label: role })),
    ],
    priorityOptions: priorityChoices(),
    statusOptions: CREATE_STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] })),
    addressHint:
      roster.length > 0
        ? `The address teammates use — ${roster.join(" · ")} — or leave it unassigned, for whoever takes it.`
        : "No agents on this team yet — the task waits unassigned.",
    bodyPlaceholder: `What to do — markdown, up to ${Math.round(TASK_CAPS.bodyMax / 1024)} KiB; a long brief belongs in an artifact`,
  };
}
