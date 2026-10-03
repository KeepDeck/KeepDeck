import { useState } from "react";
import { Combobox, Dropdown } from "@keepdeck/ui-kit";
import type { TaskPriority, TaskStatus } from "../../domain/tasks";
import {
  DIALOG_WORDS,
  EMPTY_COMPOSER,
  FIELD_WORDS,
  TASK_DETAIL_WORDS,
  beginSend,
  composerCanSend,
  finishSend,
  pickedArtifact,
  pickedStatus,
  taskDetailClassName,
  typeDraft,
  type FeedChange,
  type TaskDetailView,
} from "../../presentation/tasks";
import { Button } from "../../ui/Button";

interface TaskDetailProps {
  view: TaskDetailView;
  /** Whether the task fills the stage; the head offers the way there and back. */
  wide: boolean;
  onToggleWide(): void;
  onClose(): void;
  onMove(taskId: string, to: TaskStatus): void;
  onAssign(taskId: string, assignee: string): void;
  onPriority(taskId: string, priority: TaskPriority): void;
  /** Resolves to whether the comment was accepted; the draft is cleared
   * only then — a refused comment must not vanish with its refusal. */
  onComment(taskId: string, body: string): Promise<boolean>;
  onSelect(taskId: string): void;
  onAttach(taskId: string, slug: string): void;
  onDetach(taskId: string, slug: string): void;
  onOpenArtifact(slug: string): void;
  /** Resolves to whether the label landed — the field keeps a refused one. */
  onLabel(taskId: string, label: string): Promise<boolean>;
  onUnlabel(taskId: string, label: string): void;
}

/** The right panel: one task whole. Every word comes from the view; every
 * control emits an intent. */
export function TaskDetail({
  view,
  wide,
  onToggleWide,
  onClose,
  onMove,
  onAssign,
  onPriority,
  onComment,
  onSelect,
  onAttach,
  onDetach,
  onOpenArtifact,
  onLabel,
  onUnlabel,
}: TaskDetailProps) {
  const [composer, setComposer] = useState(EMPTY_COMPOSER);
  const [labelDraft, setLabelDraft] = useState("");
  const submitLabel = () => {
    const typed = labelDraft;
    void onLabel(view.id, typed).then((landed) => {
      if (landed) setLabelDraft("");
    });
  };
  const sendable = composerCanSend(composer);
  const send = () => {
    const begun = beginSend(composer);
    if (!begun) return;
    setComposer(begun.state);
    void onComment(view.id, begun.body).then((accepted) => {
      // What a finished send may clear is the composer's own rule: the
      // text it sent, when accepted — never what was typed since.
      setComposer((current) => finishSend(current, accepted));
    });
  };
  return (
    <aside className={taskDetailClassName(wide)} aria-label={TASK_DETAIL_WORDS.panel(view.id)}>
      <div className="tasks__detail-head">
        <h3 className="tasks__detail-title kd-two-lines">{view.title}</h3>
        {/* Words, not a ×: the dialog's own × sits right above, and two
            stacked read as a mistake. */}
        <div className="tasks__detail-actions">
          <Button size="sm" variant="ghost" pressed={wide} onClick={onToggleWide}>
            {DIALOG_WORDS.wide(wide)}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {TASK_DETAIL_WORDS.close}
          </Button>
        </div>
      </div>
      <p className="tasks__detail-meta">
        <code>{view.meta}</code>
      </p>

      {/* The task's properties as a list of pickers, the way an issue
          tracker lays them out: pick a status, do not read a verb. What
          may be picked is the transition table's answer, carried in the
          view — nothing here decides it. */}
      <div className="tasks__props">
        <span className="tasks__prop-label">{FIELD_WORDS.status}</span>
        <Dropdown
          ariaLabel={FIELD_WORDS.status}
          options={view.statusOptions.map((option) => ({
            value: option.value,
            label: (
              <span className="tasks__status-choice">
                <span className={option.dotClassName} />
                {option.label}
              </span>
            ),
          }))}
          value={view.status}
          onChange={(value) => {
            const to = pickedStatus(view.status, value);
            if (to !== null) onMove(view.id, to);
          }}
          className="tasks__pick"
        />
        <span className="tasks__prop-label">{FIELD_WORDS.priority}</span>
        <Dropdown
          ariaLabel={FIELD_WORDS.priority}
          options={view.priorityOptions}
          value={view.priority}
          onChange={(value) => onPriority(view.id, value as TaskPriority)}
          className="tasks__pick"
        />
        <span className="tasks__prop-label">{FIELD_WORDS.assignee}</span>
        <Dropdown
          ariaLabel={FIELD_WORDS.assignee}
          options={view.assigneeOptions}
          value={view.assignee}
          onChange={(value) => onAssign(view.id, value)}
          className="tasks__pick"
        />
      </div>

      <span className="tasks__section">{FIELD_WORDS.brief}</span>
      {view.bodyEmpty ? <p className="tasks__muted">{view.bodyEmpty}</p> : <p className="tasks__body kd-selectable">{view.body}</p>}

      <span className="tasks__section">{TASK_DETAIL_WORDS.blockers}</span>
      {view.blockersEmpty ? (
        <p className="tasks__muted">{view.blockersEmpty}</p>
      ) : (
        <ul className="tasks__links">
          {view.blockers.map((blocker) => (
            <li key={blocker.id}>
              <button type="button" className="tasks__link" onClick={() => onSelect(blocker.id)}>
                <span className="kd-two-lines">
                  <code>{blocker.text}</code>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {view.unblocks.length > 0 && (
        <>
          <span className="tasks__section">{TASK_DETAIL_WORDS.unblocks}</span>
          <ul className="tasks__links">
            {view.unblocks.map((other) => (
              <li key={other.id}>
                <button type="button" className="tasks__link" onClick={() => onSelect(other.id)}>
                  <span className="kd-two-lines">
                    <code>{other.id}</code> {other.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <span className="tasks__section">{TASK_DETAIL_WORDS.artifacts}</span>
      {view.artifacts.length > 0 && (
        <ul className="tasks__links">
          {view.artifacts.map((artifact) => (
            <li key={artifact.slug} className="tasks__artifact">
              {/* The title opens it; the slug is the durable half a
                  teammate is given. A row the registry no longer holds
                  still reads, but has nothing to open. */}
              <button
                type="button"
                className="tasks__link"
                disabled={!artifact.known}
                title={artifact.openTitle}
                onClick={() => onOpenArtifact(artifact.slug)}
              >
                <span className="kd-two-lines">
                  {artifact.title} <code>{artifact.slug}</code>
                </span>
              </button>
              <button
                type="button"
                className="tasks__remove"
                aria-label={artifact.detachLabel}
                title={TASK_DETAIL_WORDS.detach}
                onClick={() => onDetach(view.id, artifact.slug)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {view.attachOptions.length > 0 ? (
        <Dropdown
          ariaLabel={TASK_DETAIL_WORDS.attach}
          options={[{ value: "", label: TASK_DETAIL_WORDS.attachPrompt }, ...view.attachOptions]}
          value=""
          onChange={(picked) => {
            const slug = pickedArtifact(picked);
            if (slug !== null) onAttach(view.id, slug);
          }}
          className="tasks__pick"
        />
      ) : (
        view.attachEmpty && <p className="tasks__muted">{view.attachEmpty}</p>
      )}

      <span className="tasks__section">{TASK_DETAIL_WORDS.labels}</span>
      {view.labels.length > 0 && (
        <ul className="tasks__labels tasks__labels--edit">
          {view.labels.map((item) => (
            <li key={item.label} className="tasks__label">
              {item.label}
              <button
                type="button"
                className="tasks__remove"
                aria-label={item.removeLabel}
                title={item.removeLabel}
                onClick={() => onUnlabel(view.id, item.label)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {view.labelsFull ? (
        <p className="tasks__muted">{view.labelsFull}</p>
      ) : (
        <form
          className="tasks__label-add"
          onSubmit={(event) => {
            event.preventDefault();
            submitLabel();
          }}
        >
          <Combobox
            ariaLabel={TASK_DETAIL_WORDS.addLabel}
            placeholder={TASK_DETAIL_WORDS.labelPrompt}
            options={view.labelOptions}
            value={labelDraft}
            onChange={setLabelDraft}
          />
        </form>
      )}

      <span className="tasks__section">{TASK_DETAIL_WORDS.activity}</span>
      {view.feedEmpty && <p className="tasks__muted">{view.feedEmpty}</p>}
      <ul className="tasks__feed">
        {view.feed.map((item) =>
          item.kind === "comment" ? (
            <li key={item.key} className="tasks__comment">
              <span className="tasks__comment-who">
                {item.who} · {item.age}
              </span>
              <span className="tasks__comment-body kd-selectable">{item.body}</span>
            </li>
          ) : item.kind === "change" ? (
            <FeedChangeLine key={item.key} change={item} />
          ) : (
            <li key={item.key}>
              <details className="tasks__feed-more">
                <summary>{item.label}</summary>
                <ul className="tasks__feed">
                  {item.changes.map((change) => (
                    <FeedChangeLine key={change.key} change={change} />
                  ))}
                </ul>
              </details>
            </li>
          ),
        )}
      </ul>
      <textarea
        className="form__input tasks__composer"
        placeholder={TASK_DETAIL_WORDS.commentPlaceholder}
        aria-label={TASK_DETAIL_WORDS.comment}
        value={composer.draft}
        maxLength={view.commentMax}
        onChange={(e) => setComposer((current) => typeDraft(current, e.target.value))}
      />
      <div className="tasks__composer-actions">
        <Button size="sm" onClick={send} disabled={!sendable}>
          {TASK_DETAIL_WORDS.comment}
        </Button>
      </div>

    </aside>
  );
}

function FeedChangeLine({ change }: { change: FeedChange }) {
  return (
    <li className="tasks__log">
      <span className="tasks__log-who">{change.who}</span> <span className="tasks__log-text">{change.text}</span>{" "}
      <span className="tasks__log-age">· {change.age}</span>
    </li>
  );
}
