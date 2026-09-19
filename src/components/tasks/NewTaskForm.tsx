import { useState } from "react";
import { Dropdown } from "@keepdeck/ui-kit";
import type { CreateTaskInput, TaskPriority } from "../../domain/tasks";
import type { NewTaskFormView } from "../../presentation/tasks";
import { Button } from "../../ui/Button";
import { CloseButton } from "../../ui/CloseButton";

interface NewTaskFormProps {
  view: NewTaskFormView;
  onCreate(input: Omit<CreateTaskInput, "teamId">): void;
  onCancel(): void;
}

/** The person's own door onto the board: they name the work and, if they
 * want, who does it. Nothing here delivers anything. */
export function NewTaskForm({ view, onCreate, onCancel }: NewTaskFormProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const submit = () => {
    if (title.trim() === "") return;
    onCreate({ title, body, assignee: assignee === "" ? null : assignee, priority });
  };
  return (
    <aside className="tasks__detail tasks__compose" aria-label="New task">
      <div className="tasks__compose-head">
        <h3 className="tasks__detail-title">New task</h3>
        <CloseButton label="Close the form" onClick={onCancel} />
      </div>
      <p className="tasks__muted">Put work on the team's board — assign it now or leave it in the pool for whoever takes it.</p>
      <span className="tasks__section">Title</span>
      <input
        className="form__input"
        aria-label="Title"
        value={title}
        maxLength={view.titleMax}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      <span className="tasks__section">Brief</span>
      <textarea
        className="form__input tasks__composer"
        aria-label="Brief"
        placeholder={view.bodyPlaceholder}
        value={body}
        maxLength={view.bodyMax}
        onChange={(e) => setBody(e.target.value)}
      />
      <span className="tasks__section">Priority</span>
      <div className="form__types">
        {view.priorityOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`form__type${option.value === priority ? " form__type--active" : ""}`}
            onClick={() => setPriority(option.value as TaskPriority)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <span className="tasks__section">Assignee</span>
      <Dropdown ariaLabel="Assignee" options={view.assigneeOptions} value={assignee} onChange={setAssignee} className="tasks__pick" />
      <p className="tasks__muted">{view.addressHint}</p>
      <div className="tasks__composer-actions">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={title.trim() === ""}>
          Create task
        </Button>
      </div>
    </aside>
  );
}
