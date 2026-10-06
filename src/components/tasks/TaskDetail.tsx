import { Fragment, useId, useMemo, useRef, useState } from "react";
import { Combobox, DisclosureChevron, Dropdown, MenuButton, PlusIcon, StatusRing } from "@keepdeck/ui-kit";
import type { BlockerSide, TaskPriority, TaskStatus } from "../../domain/tasks";
import {
  DIALOG_WORDS,
  EMPTY_COMPOSER,
  FIELD_WORDS,
  TASK_DETAIL_WORDS,
  beginSend,
  composerCanSend,
  fieldCount,
  labelDraftAfter,
  labelSendable,
  finishSend,
  pickedStatus,
  taskDetailClassName,
  renamedTitle,
  typeDraft,
  cardRowEstimate,
  menuActionDisabled,
  cardRowKey,
  cardRows,
  type CardRow,
  type FeedChange,
  type PaletteKind,
  type TaskAction,
  type TaskDetailView,
} from "../../presentation/tasks";
import { Button } from "../../ui/Button";
import { TipButton } from "../../ui/TipButton";
import { CloseIcon, MaximizeIcon, RestoreIcon } from "@keepdeck/ui-kit/icons";
import { VirtualList } from "@keepdeck/ui-kit/VirtualList";
import { RemoveButton } from "../../ui/RemoveButton";
import { CommandPalette } from "../../ui/CommandPalette";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { RenameInput } from "../../ui/RenameInput";
import { useInlineRename } from "../../ui/useInlineRename";
import { useGrowingField } from "../../ui/useGrowingField";

interface TaskDetailProps {
  view: TaskDetailView;
  /** Whether the task fills the stage; the head offers the way there and back. */
  wide: boolean;
  onToggleWide(): void;
  /** Copy this task as a fresh one, and open the copy. */
  onDuplicate(taskId: string): void;
  /** A copy is on its way: the control waits. */
  copying: boolean;
  /** Hand this task to another team. */
  onTransfer(taskId: string, teamId: string): void;
  /** Give the task a new title; resolves to whether it was taken. */
  onRename(taskId: string, title: string): Promise<boolean>;
  /** The activity's heading: shut ⇄ open. */
  onToggleActivity(): void;
  onClose(): void;
  onMove(taskId: string, to: TaskStatus): void;
  onAssign(taskId: string, assignee: string): void;
  onPriority(taskId: string, priority: TaskPriority): void;
  /** Resolves to whether the comment was accepted; the draft is cleared
   * only then — a refused comment must not vanish with its refusal. */
  onComment(taskId: string, body: string): Promise<boolean>;
  onSelect(taskId: string): void;
  onAttach(taskId: string, slug: string): void;
  /** Link the open task to `otherId` on `side` of a blocker link. */
  onLink(taskId: string, otherId: string, side: BlockerSide): void;
  onUnblock(taskId: string, blockerId: string): void;
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
  onDuplicate,
  copying,
  onTransfer,
  onRename,
  onToggleActivity,
  onClose,
  onMove,
  onAssign,
  onPriority,
  onComment,
  onSelect,
  onAttach,
  onDetach,
  onLink,
  onUnblock,
  onOpenArtifact,
  onLabel,
  onUnlabel,
}: TaskDetailProps) {
  const [composer, setComposer] = useState(EMPTY_COMPOSER);
  // The transfer's inline confirm: the team picked, or null while closed.
  const [transferTo, setTransferTo] = useState<string | null>(null);
  // The copy's confirm, open or not: a stray click must not make a task.
  const [duplicating, setDuplicating] = useState(false);
  /** The picker open over the task, if any. */
  const [palette, setPalette] = useState<PaletteKind | null>(null);
  const current = palette ? view.palette(palette) : null;
  const pick = (kind: PaletteKind, value: string) =>
    kind === "artifact" ? onAttach(view.id, value) : onLink(view.id, value, kind);
  // The title edits in place — a double click on it, or Rename in the menu —
  // by the house's one inline-rename behaviour.
  const rename = useInlineRename((taskId, typed, from) => {
    const title = renamedTitle(from, typed);
    if (title === null) return;
    // Refused (past the cap, say): the field opens again on what was typed,
    // never dropping it — the refusal shows above as any write's does.
    void onRename(taskId, title).then((landed) => {
      if (!landed) rename.start(taskId, typed);
    });
  });
  const actionOf: Record<TaskAction["id"], () => void> = {
    rename: () => rename.start(view.id, view.title),
    "blocked-by": () => setPalette("blocked-by"),
    blocks: () => setPalette("blocks"),
    duplicate: () => setDuplicating(true),
    transfer: () => setTransferTo(view.transfer.initial),
  };
  const transferTeam = view.transfer.options.find((option) => option.value === transferTo);
  const commentField = useRef<HTMLTextAreaElement>(null);
  const activityId = useId();
  useGrowingField(commentField, composer.draft);
  const [labelDraft, setLabelDraft] = useState("");
  const submitLabel = () => {
    const typed = labelDraft;
    if (!labelSendable(typed)) return;
    void onLabel(view.id, typed).then((landed) => setLabelDraft((current) => labelDraftAfter(current, typed, landed)));
  };
  const sendable = composerCanSend(composer);
  const commentCount = fieldCount("comment", composer.draft);
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
  // Built once per view: a keystroke in the comment field re-renders the
  // card, and must not hand the list a new set of rows each time.
  const rows = useMemo(() => cardRows(view), [view]);
  const renderRow = (row: CardRow) => {
    switch (row.kind) {
      case "story":
        return (
          <div className="tasks__card-story">
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
                    <span key={blocker.id} className={`${blocker.className} tasks__blocker--edit`}>
                      {/* The chip opens the blocker; the cross lets it go. */}
                      <button type="button" className="tasks__link" onClick={() => onSelect(blocker.id)}>
                        {blocker.text}
                      </button>
                      <RemoveButton size="sm" label={blocker.removeLabel} onClick={() => onUnblock(view.id, blocker.id)} />
                    </span>
                  ))
                )}
                {view.canAddBlocker && <AddButton label={TASK_DETAIL_WORDS.addBlocker} onClick={() => setPalette("blocked-by")} />}
              </dd>

              {view.unblocksShown && (
                <>
                  <dt className="tasks__prop-label">{TASK_DETAIL_WORDS.unblocks}</dt>
                  <dd className="tasks__chips">
                    {view.unblocksEmpty && <span className="tasks__muted">{view.unblocksEmpty}</span>}
                    {view.unblocks.map((other) => (
                      <button key={other.id} type="button" className="kd-tag kd-tag--outline" title={other.title} onClick={() => onSelect(other.id)}>
                        {other.id}
                      </button>
                    ))}
                    {view.canAddDependant && <AddButton label={TASK_DETAIL_WORDS.addDependant} onClick={() => setPalette("blocks")} />}
                  </dd>
                </>
              )}

              {view.copies.map((row) => (
                <Fragment key={row.label}>
                  <dt className="tasks__prop-label">{row.label}</dt>
                  <dd className="tasks__chips">
                    {row.tasks.map((other) => (
                      <button key={other.id} type="button" className="kd-tag kd-tag--outline" title={other.title} onClick={() => onSelect(other.id)}>
                        {other.id}
                      </button>
                    ))}
                    {row.gone && <span className="tasks__muted">{row.gone}</span>}
                  </dd>
                </Fragment>
              ))}

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
                      title={artifact.openTitle}
                      onClick={() => onOpenArtifact(artifact.slug)}
                    >
                      {artifact.title}
                    </button>
                    <RemoveButton size="sm" label={artifact.detachLabel} onClick={() => onDetach(view.id, artifact.slug)} />
                  </span>
                ))}
                {view.canAttach ? (
                  <AddButton label={TASK_DETAIL_WORDS.addArtifact} onClick={() => setPalette("artifact")} />
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
            </div>
          </div>
        );
      case "comments":
        return (
          <div className="tasks__card-heading">
            {/* A real heading: the comments are rows of the card's one
                list, not a list of their own, so a reader reaches them by it. */}
            <h4 className="tasks__section">{TASK_DETAIL_WORDS.comments}</h4>
            {row.empty && <p className="tasks__muted">{row.empty}</p>}
          </div>
        );
      case "comment":
        return (
          <div className="tasks__card-cell">
            <div className="tasks__comment">
              <span className="tasks__comment-who">
                <b>{row.comment.who}</b> · {row.comment.age}
              </span>
              <span className="tasks__comment-body kd-selectable">{row.comment.body}</span>
            </div>
          </div>
        );
      case "activity":
        return (
          <div className="tasks__card-heading tasks__card-heading--activity">
            <h4 className="tasks__card-heading-title">
              <button
                type="button"
                className="tasks__section tasks__section--toggle"
                aria-expanded={view.activity.open}
                onClick={onToggleActivity}
              >
                {view.activity.label}
                <DisclosureChevron open={view.activity.open} />
              </button>
            </h4>
            {row.empty && <p className="tasks__muted">{row.empty}</p>}
          </div>
        );
      case "change":
        return <FeedChangeLine change={row.change} />;
    }
  };
  return (
    <aside className={taskDetailClassName(wide)} aria-label={TASK_DETAIL_WORDS.panel(view.id)}>
      <header className="tasks__detail-head">
        <div className="tasks__detail-line">
          <StatusRing {...view.statusRing} />
          <span className="tasks__detail-meta kd-one-line">{view.meta}</span>
          {/* The task's own menu stands with what names the task — its id
              and state, as Linear's beside the issue key — apart from the
              window's controls at the line's end. Bordered, not ghost: a
              ghost glyph went unseen. */}
          <MenuButton
            variant="secondary"
            size="sm"
            className="tasks__detail-menu"
            ariaLabel={view.menu.label}
            actions={view.menu.actions.map((action) => ({
              id: action.id,
              label: action.label,
              disabled: menuActionDisabled(action, copying),
              refusal: action.refusal ?? undefined,
              onSelect: actionOf[action.id],
            }))}
          >
            ⋯
          </MenuButton>
          <span className="tasks__detail-tools">
            {/* An icon, explained by its tip — beside the close, its kin. */}
            <TipButton
              size="sm"
              tip={DIALOG_WORDS.wide(wide)}
              label={DIALOG_WORDS.expand}
              expanded={wide}
              onClick={onToggleWide}
            >
              {wide ? <RestoreIcon /> : <MaximizeIcon />}
            </TipButton>
            <TipButton size="sm" tip={TASK_DETAIL_WORDS.close} onClick={onClose}>
              <CloseIcon />
            </TipButton>
          </span>
        </div>
        {rename.editing === view.id ? (
          <RenameInput rename={rename} className="tasks__detail-title-edit" label={TASK_DETAIL_WORDS.renameField} multiline />
        ) : (
          <h3
            className="tasks__detail-title kd-selectable"
            dir="auto"
            onDoubleClick={() => rename.start(view.id, view.title)}
          >
            {view.title}
          </h3>
        )}
        {palette && current && (
          <CommandPalette
            label={current.label}
            placeholder={current.placeholder}
            empty={current.empty}
            sections={current.sections.map((section) => ({
              title: section.title,
              items: section.items.map((item) => ({
                value: item.value,
                label: item.label,
                hint: item.hint,
                leading: item.ring && <StatusRing {...item.ring} />,
              })),
            }))}
            onPick={(value) => pick(palette, value)}
            onClose={() => setPalette(null)}
          />
        )}
        {duplicating && (
          <ConfirmDialog
            title={view.duplicate.title}
            message={view.duplicate.message}
            confirmLabel={view.duplicate.confirm}
            cancelLabel={view.duplicate.cancel}
            onConfirm={() => {
              setDuplicating(false);
              onDuplicate(view.id);
            }}
            onCancel={() => setDuplicating(false)}
          />
        )}
        {/* The house confirm, centred over everything: where to, what it
            means, and the two answers. */}
        {transferTeam && (
          <ConfirmDialog
            title={view.transfer.title}
            message={view.transfer.confirm(transferTeam.label)}
            confirmLabel={view.transfer.move}
            cancelLabel={view.transfer.cancel}
            onConfirm={() => {
              setTransferTo(null);
              onTransfer(view.id, transferTeam.value);
            }}
            onCancel={() => setTransferTo(null)}
          >
            <label className="tasks__transfer-pick">
              <span className="tasks__prop-label">{view.transfer.prompt}</span>
              <Dropdown
                ariaLabel={view.transfer.prompt}
                options={view.transfer.options}
                value={transferTeam.value}
                onChange={setTransferTo}
              />
            </label>
          </ConfirmDialog>
        )}
      </header>

      {/* Everything between the head and the comment field is ONE windowed
          list of rows of several kinds (task-280): only what is in view is
          drawn, however long the thread grows. A new task starts at the
          top; at the thread's foot, a new comment keeps it in sight. */}
      <VirtualList
        key={view.id}
        items={rows}
        itemKey={cardRowKey}
        estimate={cardRowEstimate}
        render={renderRow}
        className="tasks__detail-body"
        item={{ className: "tasks__card-row" }}
        easeKey={view.activity.open}
        followEnd
      />
      <div className="tasks__detail-composer">
        <div className="tasks__composer-row">
          <div className="tasks__field tasks__field--grow">
            <textarea
              ref={commentField}
              rows={1}
              className="form__input tasks__comment-input"
              placeholder={TASK_DETAIL_WORDS.commentPlaceholder}
              aria-label={TASK_DETAIL_WORDS.comment}
              aria-describedby={`${activityId}-count`}
              value={composer.draft}
              onChange={(e) => setComposer((current) => typeDraft(current, e.target.value))}
            />
            <span id={`${activityId}-count`} className={commentCount.className}>
              {commentCount.text}
            </span>
          </div>
          <Button onClick={send} disabled={!sendable}>
            {TASK_DETAIL_WORDS.comment}
          </Button>
        </div>
      </div>
    </aside>
  );
}

/** A row's + — opens the picker that adds to it. */
function AddButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button type="button" className="tasks__add" aria-label={label} title={label} onClick={onClick}>
      <PlusIcon />
    </button>
  );
}

function FeedChangeLine({ change }: { change: FeedChange }) {
  return (
    <div className="tasks__log">
      <span className="tasks__log-who">{change.who}</span> <span className="tasks__log-text">{change.text}</span>{" "}
      <span className="tasks__log-age">· {change.age}</span>
    </div>
  );
}
