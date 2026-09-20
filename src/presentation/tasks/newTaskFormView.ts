import { TASK_CAPS } from "../../domain/tasks";
import { POOL_LABEL, priorityChoices, type ChoiceView } from "./words";

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

export function newTaskFormView(roster: readonly string[]): NewTaskFormView {
  return {
    assigneeOptions: [
      { value: "", label: `${POOL_LABEL} — unassigned` },
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
