import { useState } from "react";
import { Dropdown } from "@keepdeck/ui-kit";
import type { CreateTaskInput, TaskPriority } from "../../domain/tasks";
import {
  EMPTY_TASK_DRAFT,
  FIELD_WORDS,
  NEW_TASK_WORDS,
  canCreateTask,
  priorityChoiceClassName,
  taskInputOf,
  type NewTaskFormView,
} from "../../presentation/tasks";
import { Button } from "../../ui/Button";

interface NewTaskFormProps {
  view: NewTaskFormView;
  onCreate(input: Omit<CreateTaskInput, "teamId">): void;
  onCancel(): void;
}

/** The person's own door onto the board: they name the work and, if they
 * want, who does it. Nothing here delivers anything. No × of its own: the
 * dialog's is right above it, and two stacked read as a mistake — Cancel,
 * + Task again and Escape put the form away. */
export function NewTaskForm({ view, onCreate, onCancel }: NewTaskFormProps) {
  const [draft, setDraft] = useState(EMPTY_TASK_DRAFT);
  const creatable = canCreateTask(draft.title);
  const submit = () => {
    if (!creatable) return;
    onCreate(taskInputOf(draft));
  };
  return (
    <aside className="tasks__detail tasks__compose" aria-label={NEW_TASK_WORDS.panel}>
      {/* The fields scroll; the actions do not — a Create button that has
          to be scrolled to is a form that looks like it cannot be sent. */}
      <div className="tasks__compose-body">
      <h3 className="tasks__detail-title">{NEW_TASK_WORDS.panel}</h3>
      <p className="tasks__muted">{NEW_TASK_WORDS.intro}</p>
      <span className="tasks__section">{FIELD_WORDS.title}</span>
      <input
        className="form__input"
        aria-label={FIELD_WORDS.title}
        value={draft.title}
        maxLength={view.titleMax}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        autoFocus
      />
      <span className="tasks__section">{FIELD_WORDS.brief}</span>
      <textarea
        className="form__input tasks__composer"
        aria-label={FIELD_WORDS.brief}
        placeholder={view.bodyPlaceholder}
        value={draft.body}
        maxLength={view.bodyMax}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
      />
      <span className="tasks__section">{FIELD_WORDS.priority}</span>
      <div className="form__types">
        {view.priorityOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={priorityChoiceClassName(option.value === draft.priority)}
            onClick={() => setDraft({ ...draft, priority: option.value as TaskPriority })}
          >
            {option.label}
          </button>
        ))}
      </div>
      <span className="tasks__section">{FIELD_WORDS.assignee}</span>
      <Dropdown
        ariaLabel={FIELD_WORDS.assignee}
        options={view.assigneeOptions}
        value={draft.assignee}
        onChange={(assignee) => setDraft({ ...draft, assignee })}
        className="tasks__pick"
      />
      <p className="tasks__muted">{view.addressHint}</p>
      </div>
      <div className="tasks__composer-actions tasks__compose-actions">
        <Button variant="secondary" onClick={onCancel}>
          {NEW_TASK_WORDS.cancel}
        </Button>
        <Button variant="primary" onClick={submit} disabled={!creatable}>
          {NEW_TASK_WORDS.create}
        </Button>
      </div>
    </aside>
  );
}
