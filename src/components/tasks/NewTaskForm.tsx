import { useId, useState } from "react";
import { Dropdown } from "@keepdeck/ui-kit";
import type { CreateTaskInput } from "../../domain/tasks";
import {
  FIELD_WORDS,
  NEW_TASK_WORDS,
  canCreateTask,
  fieldCount,
  takesAnEpic,
  taskInputOf,
  type NewTaskFormView,
} from "../../presentation/tasks";
import { Button } from "../../ui/Button";
import { Segmented } from "@keepdeck/ui-kit/Segmented";

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
  const [draft, setDraft] = useState(view.draft);
  const creatable = canCreateTask(draft.title, draft.body);
  const titleCount = fieldCount("title", draft.title);
  const bodyCount = fieldCount("body", draft.body);
  const countId = useId();
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
      <span className="tasks__section">{FIELD_WORDS.kind}</span>
      <Segmented
        ariaLabel={FIELD_WORDS.kind}
        options={view.kindOptions}
        value={draft.kind}
        onChange={(kind) => setDraft({ ...draft, kind })}
      />
      <span className="tasks__section">{FIELD_WORDS.title}</span>
      <div className="tasks__field">
        <input
          className="form__input"
          aria-label={FIELD_WORDS.title}
          aria-describedby={`${countId}-title`}
          dir="auto"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          autoFocus
        />
        <span id={`${countId}-title`} className={titleCount.className}>
          {titleCount.text}
        </span>
      </div>
      <span className="tasks__section">{FIELD_WORDS.brief}</span>
      <div className="tasks__field">
        <textarea
          className="form__input tasks__composer"
          aria-label={FIELD_WORDS.brief}
          placeholder={view.bodyPlaceholder}
          aria-describedby={`${countId}-body`}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
        <span id={`${countId}-body`} className={bodyCount.className}>
          {bodyCount.text}
        </span>
      </div>
      {takesAnEpic(draft) && (
        <>
          <span className="tasks__section">{FIELD_WORDS.epic}</span>
          <Dropdown
            ariaLabel={FIELD_WORDS.epic}
            options={view.epicOptions}
            value={draft.parent}
            onChange={(parent) => setDraft({ ...draft, parent })}
            size="sm"
          />
        </>
      )}
      <span className="tasks__section">{FIELD_WORDS.status}</span>
      <Segmented
        ariaLabel={FIELD_WORDS.status}
        options={view.statusOptions}
        value={draft.status}
        onChange={(status) => setDraft({ ...draft, status })}
      />
      <span className="tasks__section">{FIELD_WORDS.priority}</span>
      <Segmented
        ariaLabel={FIELD_WORDS.priority}
        options={view.priorityOptions}
        value={draft.priority}
        onChange={(priority) => setDraft({ ...draft, priority })}
      />
      <span className="tasks__section">{FIELD_WORDS.assignee}</span>
      <Dropdown
        ariaLabel={FIELD_WORDS.assignee}
        options={view.assigneeOptions}
        value={draft.assignee}
        onChange={(assignee) => setDraft({ ...draft, assignee })}
        size="sm"
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
