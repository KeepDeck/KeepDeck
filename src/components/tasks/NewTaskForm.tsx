import { useState } from "react";
import { Dropdown } from "@keepdeck/ui-kit";
import type { CreateTaskInput, TaskPriority } from "../../domain/tasks";
import { EMPTY_TASK_DRAFT, canCreateTask, taskInputOf, type NewTaskFormView } from "../../presentation/tasks";
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
    <aside className="tasks__detail tasks__compose" aria-label="New task">
      {/* The fields scroll; the actions do not — a Create button that has
          to be scrolled to is a form that looks like it cannot be sent. */}
      <div className="tasks__compose-body">
      <h3 className="tasks__detail-title">New task</h3>
      <p className="tasks__muted">Put work on the team's board — assign it now or leave it in the pool for whoever takes it.</p>
      <span className="tasks__section">Title</span>
      <input
        className="form__input"
        aria-label="Title"
        value={draft.title}
        maxLength={view.titleMax}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        autoFocus
      />
      <span className="tasks__section">Brief</span>
      <textarea
        className="form__input tasks__composer"
        aria-label="Brief"
        placeholder={view.bodyPlaceholder}
        value={draft.body}
        maxLength={view.bodyMax}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
      />
      <span className="tasks__section">Priority</span>
      <div className="form__types">
        {view.priorityOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`form__type${option.value === draft.priority ? " form__type--active" : ""}`}
            onClick={() => setDraft({ ...draft, priority: option.value as TaskPriority })}
          >
            {option.label}
          </button>
        ))}
      </div>
      <span className="tasks__section">Assignee</span>
      <Dropdown
        ariaLabel="Assignee"
        options={view.assigneeOptions}
        value={draft.assignee}
        onChange={(assignee) => setDraft({ ...draft, assignee })}
        className="tasks__pick"
      />
      <p className="tasks__muted">{view.addressHint}</p>
      </div>
      <div className="tasks__composer-actions tasks__compose-actions">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={!creatable}>
          Create task
        </Button>
      </div>
    </aside>
  );
}
