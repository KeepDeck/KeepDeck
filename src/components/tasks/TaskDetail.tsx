import { useState } from "react";
import { Combobox, Dropdown, StatusRing } from "@keepdeck/ui-kit";
import type { TaskPriority, TaskStatus } from "../../domain/tasks";
import {
  DIALOG_WORDS,
  EMPTY_COMPOSER,
  FIELD_WORDS,
  TASK_DETAIL_WORDS,
  beginSend,
  composerCanSend,
  labelDraftAfter,
  labelSendable,
  finishSend,
  pickedArtifact,
  pickedStatus,
  taskDetailClassName,
  typeDraft,
  type FeedChange,
  type TaskDetailView,
} from "../../presentation/tasks";
import { Button } from "../../ui/Button";
import { TipButton } from "../../ui/TipButton";
import { CloseIcon, MaximizeIcon, RestoreIcon } from "@keepdeck/ui-kit/icons";
import { RemoveButton } from "../../ui/RemoveButton";

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
    if (!labelSendable(typed)) return;
    void onLabel(view.id, typed).then((landed) => setLabelDraft((current) => labelDraftAfter(current, typed, landed)));
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
      <header className="tasks__detail-head">
        <div className="tasks__detail-line">
          <StatusRing {...view.statusRing} />
          <span className="tasks__detail-meta kd-one-line">{view.meta}</span>
          <span className="tasks__detail-tools">
            <Button size="sm" pressed={wide} onClick={onToggleWide}>
              {wide ? <RestoreIcon /> : <MaximizeIcon />}
              {DIALOG_WORDS.wide(wide)}
            </Button>
            <TipButton size="sm" tip={TASK_DETAIL_WORDS.close} onClick={onClose}>
              <CloseIcon />
            </TipButton>
          </span>
        </div>
        <h3 className="tasks__detail-title kd-two-lines">{view.title}</h3>
      </header>

      <div className="tasks__detail-body">
        {/* The task's properties: label on the left, the value — a picker
            where it can be changed — on the right. What may be picked is
            the transition table's answer, carried in the view. */}
        <dl className="tasks__props">
          <dt className="tasks__prop-label">{FIELD_WORDS.status}</dt>
          <dd>
            <Dropdown
              ariaLabel={FIELD_WORDS.status}
              options={view.statusOptions.map((option) => ({
                value: option.value,
                label: (
                  <span className="tasks__status-choice">
                    <StatusRing {...option.ring} />
                    {option.label}
                  </span>
                ),
              }))}
              value={view.status}
              onChange={(value) => {
                const to = pickedStatus(view.status, value);
                if (to !== null) onMove(view.id, to);
              }}
              variant="inline"
            />
          </dd>
          <dt className="tasks__prop-label">{FIELD_WORDS.assignee}</dt>
          <dd>
            <Dropdown
              ariaLabel={FIELD_WORDS.assignee}
              options={view.assigneeOptions}
              value={view.assignee}
              onChange={(value) => onAssign(view.id, value)}
              variant="inline"
            />
          </dd>
          <dt className="tasks__prop-label">{FIELD_WORDS.priority}</dt>
          <dd>
            <Dropdown
              ariaLabel={FIELD_WORDS.priority}
              options={view.priorityOptions}
              value={view.priority}
              onChange={(value) => onPriority(view.id, value as TaskPriority)}
              variant="inline"
            />
          </dd>

          <dt className="tasks__prop-label">{TASK_DETAIL_WORDS.labels}</dt>
          <dd className="tasks__chips">
            {view.labels.map((item) => (
              <span key={item.label} className="kd-tag tasks__label--edit">
                {item.label}
                <RemoveButton size="sm" label={item.removeLabel} onClick={() => onUnlabel(view.id, item.label)} />
              </span>
            ))}
            {view.labelsFull ? (
              <span className="tasks__muted">{view.labelsFull}</span>
            ) : (
              <form
                className="tasks__label-add"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitLabel();
                }}
              >
                <Combobox
                  variant="slot"
                  ariaLabel={TASK_DETAIL_WORDS.addLabel}
                  placeholder={TASK_DETAIL_WORDS.labelPrompt}
                  options={view.labelOptions}
                  value={labelDraft}
                  onChange={setLabelDraft}
                />
              </form>
            )}
          </dd>

          <dt className="tasks__prop-label">{TASK_DETAIL_WORDS.blockers}</dt>
          <dd className="tasks__chips">
            {view.blockersEmpty ? (
              <span className="tasks__muted">{view.blockersEmpty}</span>
            ) : (
              view.blockers.map((blocker) => (
                <button
                  key={blocker.id}
                  type="button"
                  className={blocker.className}
                  onClick={() => onSelect(blocker.id)}
                >
                  {blocker.text}
                </button>
              ))
            )}
          </dd>

          {view.unblocks.length > 0 && (
            <>
              <dt className="tasks__prop-label">{TASK_DETAIL_WORDS.unblocks}</dt>
              <dd className="tasks__chips">
                {view.unblocks.map((other) => (
                  <button key={other.id} type="button" className="kd-tag kd-tag--outline" title={other.title} onClick={() => onSelect(other.id)}>
                    {other.id}
                  </button>
                ))}
              </dd>
            </>
          )}

          <dt className="tasks__prop-label">{TASK_DETAIL_WORDS.artifacts}</dt>
          <dd className="tasks__chips">
            {view.artifacts.map((artifact) => (
              <span key={artifact.slug} className="kd-tag kd-tag--outline tasks__tag--artifact">
                {/* The title opens it; the slug is the durable half a
                    teammate is given. A row the registry no longer holds
                    still reads, but has nothing to open. */}
                <button
                  type="button"
                  className="tasks__link"
                  disabled={!artifact.known}
                  title={`${artifact.openTitle} — ${artifact.slug}`}
                  onClick={() => onOpenArtifact(artifact.slug)}
                >
                  {artifact.title}
                </button>
                <RemoveButton size="sm" label={artifact.detachLabel} onClick={() => onDetach(view.id, artifact.slug)} />
              </span>
            ))}
            {view.attachOptions.length > 0 ? (
              <Dropdown
                ariaLabel={TASK_DETAIL_WORDS.attach}
                options={[{ value: "", label: TASK_DETAIL_WORDS.attachPrompt }, ...view.attachOptions]}
                value=""
                onChange={(picked) => {
                  const slug = pickedArtifact(picked);
                  if (slug !== null) onAttach(view.id, slug);
                }}
                variant="inline"
                quiet
              />
            ) : (
              view.attachEmpty && (
                <span className="tasks__muted" title={view.attachEmpty.title}>
                  {view.attachEmpty.text}
                </span>
              )
            )}
          </dd>
        </dl>

        <div className="tasks__detail-main">
          {view.bodyEmpty ? (
            <p className="tasks__muted">{view.bodyEmpty}</p>
          ) : (
            <p className="tasks__body kd-selectable">{view.body}</p>
          )}

          <span className="tasks__section">{TASK_DETAIL_WORDS.activity}</span>
          {view.feedEmpty && <p className="tasks__muted">{view.feedEmpty}</p>}
          {view.feedTrimmed && <p className="tasks__muted">{view.feedTrimmed}</p>}
          <ul className="tasks__feed">
            {view.feed.map((item) =>
              item.kind === "comment" ? (
                <li key={item.key} className="tasks__comment">
                  <span className="tasks__comment-who">
                    <b>{item.who}</b> · {item.age}
                  </span>
                  <span className="tasks__comment-body kd-selectable">{item.body}</span>
                </li>
              ) : item.kind === "change" ? (
                <FeedChangeLine key={item.key} change={item} />
              ) : (
                <li key={item.key} className="tasks__log">
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
          <div className="tasks__composer-row">
            <textarea
              rows={1}
              className="form__input tasks__comment-input"
              placeholder={TASK_DETAIL_WORDS.commentPlaceholder}
              aria-label={TASK_DETAIL_WORDS.comment}
              value={composer.draft}
              maxLength={view.commentMax}
              onChange={(e) => setComposer((current) => typeDraft(current, e.target.value))}
            />
            <Button onClick={send} disabled={!sendable}>
              {TASK_DETAIL_WORDS.comment}
            </Button>
          </div>
        </div>
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
