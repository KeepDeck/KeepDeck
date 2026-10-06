import {
  CREATE_STATUSES,
  TASK_CAPS,
  TASK_KINDS,
  canHaveEpic,
  epicCandidates,
  type CreateStatus,
  type TaskBoard,
  type TaskKind,
  type TaskPriority,
} from "../../domain/tasks";
import { draftIn, type TaskDraft } from "./formDraft";
import { KIND_LABEL, NO_EPIC_CHOICE, POOL_CHOICE, STATUS_LABEL, epicChoice, priorityChoices, type ChoiceView } from "./words";

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



/** The form's own words; the fields' names are FIELD_WORDS. */
export const NEW_TASK_WORDS = {
  panel: "New task",
  intro: "Put work on the team's board — assign it now or leave it unassigned for whoever takes it.",
  cancel: "Cancel",
  create: "Create task",
} as const;


export function newTaskFormView(
  roster: readonly string[],
  /** The board and team the form makes the task on — where its epics are. */
  board: TaskBoard | null,
  teamId: string | null,
  /** The epic the form was opened in, or null. */
  epic: string | null,
): NewTaskFormView {
  // The rule's own list, asked for work about to be made in todo.
  const kind = TASK_KINDS.find(canHaveEpic)!;
  const epics = board === null || teamId === null ? [] : epicCandidates({ kind, teamId, status: "todo" }, board);
  return {
    kindOptions: TASK_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] })),
    epicOptions: [NO_EPIC_CHOICE, ...epics.map(epicChoice)],
    // Opened in an epic new work cannot go under (closed meanwhile): the
    // form starts under none rather than on a pick it would refuse.
    draft: draftIn(epic !== null && epics.some((candidate) => candidate.id === epic) ? epic : null),
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
