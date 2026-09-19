import { useState } from "react";
import { Dropdown } from "@keepdeck/ui-kit";
import type { TaskPriority, TaskStatus } from "../../domain/tasks";
import type { TaskDetailView } from "../../presentation/tasks";
import { Button } from "../../ui/Button";

interface TaskDetailProps {
  view: TaskDetailView;
  onMove(taskId: string, to: TaskStatus): void;
  onAssign(taskId: string, assignee: string): void;
  onPriority(taskId: string, priority: TaskPriority): void;
  onComment(taskId: string, body: string): void;
  onSelect(taskId: string): void;
}

/** The right panel: one task whole. Every word comes from the view; every
 * control emits an intent. */
export function TaskDetail({ view, onMove, onAssign, onPriority, onComment, onSelect }: TaskDetailProps) {
  const [draft, setDraft] = useState("");
  const send = () => {
    if (draft.trim() === "") return;
    onComment(view.id, draft);
    setDraft("");
  };
  return (
    <aside className="tasks__detail" aria-label={`Task ${view.id}`}>
      <div className="tasks__detail-status">
        <span className={`tasks__status tasks__status--${view.tone}`}>{view.statusLabel}</span>
        {view.priorityMark && <span className="tasks__mark">{view.priorityMark}</span>}
      </div>
      <h3 className="tasks__detail-title">{view.title}</h3>
      <p className="tasks__detail-meta">
        <code>{view.meta}</code>
      </p>

      <span className="tasks__section">Brief</span>
      {view.bodyEmpty ? <p className="tasks__muted">{view.bodyEmpty}</p> : <p className="tasks__body kd-selectable">{view.body}</p>}

      <span className="tasks__section">Assignee</span>
      <Dropdown
        ariaLabel="Assignee"
        options={view.assigneeOptions}
        value={view.assignee}
        onChange={(value) => onAssign(view.id, value)}
        className="tasks__pick"
      />

      <span className="tasks__section">Priority</span>
      <div className="form__types">
        {view.priorityOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`form__type${option.value === view.priority ? " form__type--active" : ""}`}
            onClick={() => onPriority(view.id, option.value as TaskPriority)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <span className="tasks__section">Move</span>
      <div className="tasks__moves">
        {view.moves.map((move) => (
          <Button key={move.to} size="sm" variant={move.primary ? "primary" : "secondary"} onClick={() => onMove(view.id, move.to)}>
            {move.label}
          </Button>
        ))}
      </div>

      <span className="tasks__section">Blockers</span>
      {view.blockersEmpty ? (
        <p className="tasks__muted">{view.blockersEmpty}</p>
      ) : (
        <ul className="tasks__links">
          {view.blockers.map((blocker) => (
            <li key={blocker.id}>
              <button type="button" className="tasks__link" onClick={() => onSelect(blocker.id)}>
                <code>{blocker.text}</code>
              </button>
            </li>
          ))}
        </ul>
      )}

      {view.unblocks.length > 0 && (
        <>
          <span className="tasks__section">Unblocks</span>
          <ul className="tasks__links">
            {view.unblocks.map((other) => (
              <li key={other.id}>
                <button type="button" className="tasks__link" onClick={() => onSelect(other.id)}>
                  <code>{other.id}</code> {other.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {view.artifacts.length > 0 && (
        <>
          <span className="tasks__section">Artifacts</span>
          <ul className="tasks__links">
            {view.artifacts.map((slug) => (
              <li key={slug}>
                <code>{slug}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      <span className="tasks__section">Thread</span>
      {view.threadEmpty && <p className="tasks__muted">{view.threadEmpty}</p>}
      {view.thread.map((comment) => (
        <div key={comment.n} className="tasks__comment">
          <span className="tasks__comment-who">
            {comment.who} · {comment.age}
          </span>
          <span className="tasks__comment-body kd-selectable">{comment.body}</span>
        </div>
      ))}
      <textarea
        className="form__input tasks__composer"
        placeholder="Add a comment — it stays with the task"
        aria-label="Comment"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="tasks__composer-actions">
        <Button size="sm" onClick={send} disabled={draft.trim() === ""}>
          Comment
        </Button>
      </div>

      {view.log.length > 0 && (
        <>
          <span className="tasks__section">Log</span>
          <ul className="tasks__log">
            {view.log.map((entry, i) => (
              <li key={i}>
                <span className="tasks__log-who">{entry.who}</span> <span className="tasks__log-text">{entry.text}</span>{" "}
                <span className="tasks__log-age">· {entry.age}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
