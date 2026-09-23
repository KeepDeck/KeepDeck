import { Dropdown } from "@keepdeck/ui-kit";
import type { ArtifactsRegistryReadPort } from "../../app/artifacts/registryRead";
import type { Workspace } from "../../domain/deck";
import { DIALOG_WORDS, tasksDialogView } from "../../presentation/tasks";
import { Button } from "../../ui/Button";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useWallClock } from "../../ui/useWallClock";
import { BoardColumns } from "./BoardColumns";
import { NewTaskForm } from "./NewTaskForm";
import { TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";
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

/** The ghost is a picture; a click on it goes nowhere. */
const noSelect = () => {};

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
 * One workspace's boards — the ladder as columns, with one task open on
 * the right. The shell renders and
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
  useEscape(board.escape, canClose);
  const view = tasksDialogView({
    ladder: board.ladder,
    drag: board.drag,
    columns: board.columns,
    teams: board.teams,
    teamId: board.teamId,
    composing: board.composing,
    detailOpen: board.detail !== null,
    wide: board.wide,
  });
  const panel =
    view.panel === "form" ? (
    <NewTaskForm view={board.form} onCreate={(input) => void board.create(input)} onCancel={board.cancelCompose} />
  ) : view.panel === "detail" && board.detail ? (
    <TaskDetail
      // Keyed by the task: the panel's own state — a draft comment — must
      // not survive a switch to another task and be sent under its id.
      key={board.detail.id}
      view={board.detail}
      wide={board.wide}
      onToggleWide={board.toggleWide}
      onClose={board.close}
      onMove={board.move}
      onAssign={board.assign}
      onPriority={board.setPriority}
      onComment={board.comment}
      onSelect={board.select}
      onAttach={board.attachArtifact}
      onDetach={board.detachArtifact}
      onOpenArtifact={board.openArtifact}
    />
  ) : null;

  return (
    <ModalOverlay>
      <div className={view.className} role="dialog" aria-modal="true" aria-label={DIALOG_WORDS.title}>
        {/* The card in flight: the SAME card, drawn by the same component
            from the same view at the same width, under the point where it
            was gripped — the board's own copy stays put, dimmed, until the
            drop moves it. */}
        {view.ghost && (
          <div className="tasks__ghost" style={view.ghost.box}>
            <TaskCard card={view.ghost.card} selected={false} onSelect={noSelect} />
          </div>
        )}
        <div className="tasks__head">
          <h2 className="form__title tasks__title">{DIALOG_WORDS.title}</h2>
          {view.toolbar && (
            <div className="tasks__toolbar">
              {view.team.kind === "pick" && (
                <Dropdown
                  ariaLabel={DIALOG_WORDS.team}
                  className="tasks__team"
                  options={view.team.options}
                  value={view.team.value}
                  onChange={board.selectTeam}
                />
              )}
              {view.team.kind === "word" && <span className="tasks__team-name">{view.team.name}</span>}
              <Button
                size="sm"
                variant="primary"
                className="tasks__new"
                aria-pressed={board.composing}
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
            {view.body.main?.kind === "columns" && (
              <div className="tasks__main">
                <BoardColumns
                  columns={board.columns}
                  selectedId={board.detail?.id ?? null}
                  drag={board.drag}
                  hover={board.hover}
                  onSelect={board.select}
                  onArm={board.armDrag}
                  onHover={board.hoverColumn}
                  onDrop={board.dropOn}
                />
              </div>
            )}
            {panel}
          </div>
        )}
      </div>
    </ModalOverlay>
  );
}
