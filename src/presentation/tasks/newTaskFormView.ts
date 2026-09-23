import { TASK_CAPS } from "../../domain/tasks";
import { POOL_CHOICE, priorityChoices, type ChoiceView } from "./words";

export interface NewTaskFormView {
  assigneeOptions: ChoiceView[];
  priorityOptions: ChoiceView[];
  titleMax: number;
  bodyMax: number;
  /** Under the assignee: the addresses teammates use, or that nobody is
   * here yet. */
  addressHint: string;
  bodyPlaceholder: string;
}

/** The form's own words; the fields' names are FIELD_WORDS. */
export const NEW_TASK_WORDS = {
  panel: "New task",
  intro: "Put work on the team's board — assign it now or leave it in the pool for whoever takes it.",
  cancel: "Cancel",
  create: "Create task",
} as const;

/** A priority choice's classes: lit when it is the one picked. */
export function priorityChoiceClassName(picked: boolean): string {
  return picked ? "form__type form__type--active" : "form__type";
}

export function newTaskFormView(roster: readonly string[]): NewTaskFormView {
  return {
    assigneeOptions: [
      POOL_CHOICE,
      ...roster.map((role) => ({ value: role, label: role })),
    ],
    priorityOptions: priorityChoices(),
    titleMax: TASK_CAPS.titleMax,
    bodyMax: TASK_CAPS.bodyMax,
    addressHint:
      roster.length > 0
        ? `The address teammates use — ${roster.join(" · ")} — or the pool, for whoever takes it.`
        : "No agents on this team yet — the task waits in the pool.",
    bodyPlaceholder: `What to do — markdown, up to ${Math.round(TASK_CAPS.bodyMax / 1024)} KiB; a long brief belongs in an artifact`,
  };
}
