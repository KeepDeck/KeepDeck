import { useRef } from "react";
import { Dropdown } from "@keepdeck/ui-kit";
import type { ArtifactsRegistryReadPort } from "../../app/artifacts/registryRead";
import type { Workspace } from "../../domain/deck";
import { DIALOG_WORDS, tasksDialogView } from "../../presentation/tasks";
import { Button } from "../../ui/Button";
import { CloseButton } from "../../ui/CloseButton";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useWallClock } from "../../ui/useWallClock";
import { NewTaskForm } from "./NewTaskForm";
import { TaskDetail } from "./TaskDetail";
import { RowLead, TaskList, TaskRowLine } from "./TaskList";
import { useTasksBoard, type TasksAccess } from "./useTasksBoard";

interface TasksDialogProps {
  /** The board's owner as the runtime hands it out. */
  tasks: TasksAccess;
  /** The workspace whose boards these are; null when none is open. */
  workspace: Workspace | null;
  /** The team the stage has open as the dialog opens — the board it
   * starts on. Read once: the stage moving under the dialog (an agent
   * focusing a pane) does not move the board. */
  stageTeam: string | null;
  /** The task the dialog is on — the modal router's, so a notification and
   * a click select through one seam. */
  focus: string | null;
  onFocus(taskId: string | null): void;
  onClose(): void;
  /** False while a transaction is stacked over this dialog. */
  canClose?: boolean;
  /** The artifacts registry's reads, bound once at the composition root. */
  artifactReads: ArtifactsRegistryReadPort;
}

/**
 * The Tasks dialog. Another workspace is another board: when the active
 * workspace changes under it (an agent can switch it while the dialog is
 * up), the board opens anew from that workspace's stage instead of
 * keeping a choice that names a team the new one does not have. The open
 * task is the modal router's and survives the remount.
 */
export function TasksDialog(props: TasksDialogProps) {
  return <WorkspaceBoard key={props.workspace?.id ?? ""} {...props} />;
}

/**
 * One workspace's boards — the team's list, with one task open on the
 * right. The shell renders and
 * emits; every transition is the hook's and every word the presentation's.
 */
function WorkspaceBoard({
  tasks,
  workspace,
  stageTeam,
  focus,
  onFocus,
  onClose,
  canClose = true,
  artifactReads,
}: TasksDialogProps) {
  const now = useWallClock(0, true);
  const board = useTasksBoard(tasks, workspace, stageTeam, focus, onFocus, onClose, now, artifactReads);
  // Escape peels one layer; which one, and whether that is the dialog
  // itself, is the screen machine's call.
  // Scoped to the dialog's own surface: a confirm stacked over it (Duplicate,
  // Transfer) owns its Escape, and one press must not peel two layers.
  const surface = useRef<HTMLDivElement>(null);
  useEscape(board.escape, canClose, surface);
  const view = tasksDialogView({
    ladder: board.ladder,
    drag: board.drag,
    inFlight: board.inFlight,
    teams: board.teams,
    teamId: board.teamId,
    composing: board.composing,
    detailOpen: board.detail !== null,
    wide: board.wide,
    nothingFound: board.nothingFound,
  });
  const panel =
    view.panel === "form" ? (
    <NewTaskForm
      // Opened in another epic, the form starts over in it.
      key={board.form.draft.parent}
      view={board.form}
      onCreate={(input) => void board.create(input)}
      onCancel={board.cancelCompose}
    />
  ) : view.panel === "detail" && board.detail ? (
    <TaskDetail
      // Keyed by the task: the panel's own state — a draft comment — must
      // not survive a switch to another task and be sent under its id.
      key={board.detail.id}
      view={board.detail}
      wide={board.wide}
      onToggleWide={board.toggleWide}
      onDuplicate={board.duplicate}
      copying={board.copying}
      onTransfer={board.transfer}
      onRename={board.rename}
      onToggleActivity={board.toggleActivity}
      onClose={board.close}
      onMove={board.move}
      onAssign={board.assign}
      onPriority={board.setPriority}
      onComment={board.comment}
      onSelect={board.select}
      onAttach={board.attachArtifact}
      onDetach={board.detachArtifact}
      onLink={board.link}
      onUnblock={board.unblock}
      onOpenArtifact={board.openArtifact}
      onLabel={board.addLabel}
      onUnlabel={board.removeLabel}
      onParent={board.setParent}
      onNewInEpic={board.composeIn}
    />
  ) : null;

  return (
    <ModalOverlay>
      <div ref={surface} className={view.className} role="dialog" aria-modal="true" aria-label={DIALOG_WORDS.title}>
        {/* The task in flight: the SAME row, drawn by the same component
            from the same view at the same width, under the point where it
            was gripped — the list's own copy stays put, dimmed, until the
            drop moves it. */}
        {view.ghost && (
          <div className="tasks__ghost" style={view.ghost.box}>
            <div className="tasks__row tasks__row--ghost">
              <RowLead lead={view.ghost.row} />
              <TaskRowLine line={view.ghost.row.line} />
            </div>
          </div>
        )}
        <div className="tasks__head" inert={view.headInert}>
          <h2 className="form__title tasks__title">{DIALOG_WORDS.title}</h2>
          {view.toolbar && (
            <div className="tasks__toolbar">
              {view.team.kind === "pick" && (
                <Dropdown
                  ariaLabel={DIALOG_WORDS.team}
                  size="sm"
                  options={view.team.options}
                  value={view.team.value}
                  onChange={board.selectTeam}
                />
              )}
              {view.team.kind === "word" && <span className="tasks__team-name kd-one-line">{view.team.name}</span>}
              {board.filters.label && (
                <Button size="sm" pressed label={board.filters.label.clear} onClick={() => board.pickLabel(null)}>
                  {board.filters.label.text}
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                className="tasks__new"
                pressed={board.composing}
                onClick={board.toggleCompose}
                disabled={view.newTaskDisabled}
              >
                {DIALOG_WORDS.newTask}
              </Button>
            </div>
          )}
          <CloseButton label={DIALOG_WORDS.close} onClick={onClose} autoFocus />
        </div>

        {board.error !== null && (
          <p className="tasks__error kd-selectable" role="alert">
            {board.error}
          </p>
        )}
        {board.unsaved !== null && (
          <p className="tasks__error kd-selectable" role="alert">
            {board.unsaved}
          </p>
        )}
        {board.restore !== null && (
          <div className="tasks__restore">
            <Button onClick={board.askRestore}>{board.restore.label}</Button>
          </div>
        )}
        {/* Restoring is the person's act alone, and it is confirmed. */}
        {board.restoreConfirm !== null && (
          <ConfirmDialog
            title={board.restoreConfirm.title}
            message={board.restoreConfirm.message}
            confirmLabel={board.restoreConfirm.confirm}
            cancelLabel={board.restoreConfirm.cancel}
            onConfirm={board.confirmRestore}
            onCancel={board.cancelRestore}
          />
        )}

        {view.body.kind === "placeholder" ? (
          <div className="tasks__placeholder">
            <span className={view.body.titleClassName} role={view.body.titleRole}>
              {view.body.title}
            </span>
            {view.body.hint && <span>{view.body.hint}</span>}
          </div>
        ) : (
          <div className="tasks__stage">
            {view.body.main?.kind === "empty" && (
              <div className="tasks__main">
                <div className="tasks__placeholder">
                  <span className="tasks__placeholder-title">{view.body.main.title}</span>
                  <span>{view.body.main.hint}</span>
                </div>
              </div>
            )}
            {view.body.main?.kind === "list" && (
              <div className="tasks__main tasks__main--list">
                <TaskList
                  items={board.listItems}
                  openId={board.detail?.id ?? null}
                  drag={board.drag}
                  hover={board.hover}
                  folds={board.folds}
                  onSelect={board.select}
                  onFold={board.fold}
                  onFoldEpic={board.foldEpic}
                  onLabel={board.pickLabel}
                  onArm={board.armDrag}
                  onHover={board.hoverGroup}
                  onDrop={board.dropOn}
                />
              </div>
            )}
          </div>
        )}
        {/* The open task or the form: over the whole dialog's right side,
            its head included — under the dialog's own toolbar it showed a
            second close and a second row of controls beneath the first. */}
        {view.body.kind === "stage" && panel}
      </div>
    </ModalOverlay>
  );
}
