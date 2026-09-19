import { Dropdown } from "@keepdeck/ui-kit";
import type { ArtifactsRegistryReadPort } from "../../app/artifacts/registryRead";
import type { Workspace } from "../../domain/deck";
import { DIALOG_WORDS, LADDER_WORDS, MODE_CHOICES, cardOf, escapeTarget, ghostBox } from "../../presentation/tasks";
import { Button } from "../../ui/Button";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useWallClock } from "../../ui/useWallClock";
import { BoardColumns } from "./BoardColumns";
import { NewTaskForm } from "./NewTaskForm";
import { QueuesLanes } from "./QueuesLanes";
import { TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";
import { useTasksBoard, type TasksAccess } from "./useTasksBoard";

interface TasksDialogProps {
  /** The board's owner as the runtime hands it out. */
  tasks: TasksAccess;
  /** The workspace whose boards these are; null when none is open. */
  workspace: Workspace | null;
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
 * The Tasks dialog — the person's view of a team's board: the ladder as
 * columns, or the load as lanes per member, with one task open on the
 * right. The shell renders and emits; every transition is the hook's and
 * every word the presentation's.
 */
export function TasksDialog({
  tasks,
  workspace,
  focus,
  onFocus,
  onClose,
  canClose = true,
  artifactReads,
}: TasksDialogProps) {
  const now = useWallClock(0, true);
  const board = useTasksBoard(tasks, workspace, focus, onFocus, now, artifactReads);
  // Escape peels one layer; which one is the presentation's call.
  useEscape(() => {
    switch (escapeTarget({ composing: board.composing, wide: board.wide, detailOpen: board.detail !== null })) {
      case "form":
        return board.cancelCompose();
      case "wide":
        return board.narrow();
      case "detail":
        return board.close();
      case "dialog":
        return onClose();
    }
  }, canClose);
  const { ladder } = board;
  const staged = ladder.kind === "board" || ladder.kind === "empty";
  const ghost = ghostBox(board.drag);
  const ghostCard = board.drag.kind === "dragging" ? cardOf(board.columns, board.drag.id) : undefined;
  const panel = board.composing ? (
    <NewTaskForm view={board.form} onCreate={(input) => void board.create(input)} onCancel={board.cancelCompose} />
  ) : board.detail ? (
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
      <div
        className={`form tasks${board.drag.kind === "dragging" ? " tasks--dragging" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Tasks"
      >
        {/* The card in flight: the SAME card, drawn by the same component
            from the same view at the same width, under the point where it
            was gripped — the board's own copy stays put, dimmed, until the
            drop moves it. */}
        {ghost && ghostCard && (
          <div className="tasks__ghost" style={ghost}>
            <TaskCard card={ghostCard} selected={false} onSelect={noSelect} />
          </div>
        )}
        <div className="tasks__head">
          <h2 className="form__title tasks__title">Tasks</h2>
          {/* The same controls whatever the view: a bar whose buttons come
              and go with the view reads as a bar that cannot be learned. */}
          {staged && (
            <div className="tasks__toolbar">
              {board.teams.length > 1 && board.teamId !== null && (
                <Dropdown
                  ariaLabel="Team"
                  className="tasks__team"
                  options={board.teams.map((team) => ({ value: team.id, label: team.name }))}
                  value={board.teamId}
                  onChange={board.selectTeam}
                />
              )}
              {board.teams.length === 1 && <span className="tasks__team-name">{board.teams[0].name}</span>}
              <div className="tasks__segment" role="group" aria-label="View">
                {MODE_CHOICES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    className={`tasks__segment-btn${board.mode === mode.value ? " tasks__segment-btn--active" : ""}`}
                    aria-pressed={board.mode === mode.value}
                    onClick={() => board.setMode(mode.value)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <div className="tasks__filter">
                <button
                  type="button"
                  className={`tasks__segment-btn${board.showCancelled ? " tasks__segment-btn--active" : ""}`}
                  aria-pressed={board.showCancelled}
                  disabled={DIALOG_WORDS.cancelledFilterHint(board.mode) !== null}
                  title={DIALOG_WORDS.cancelledFilterHint(board.mode) ?? undefined}
                  onClick={board.toggleCancelled}
                >
                  {DIALOG_WORDS.cancelledFilter(board.showCancelled)}
                </button>
              </div>
              <Button
                size="sm"
                variant="primary"
                className="tasks__new"
                aria-pressed={board.composing}
                onClick={board.composing ? board.cancelCompose : board.compose}
                disabled={board.teamId === null}
              >
                + Task
              </Button>
            </div>
          )}
          <CloseButton label="Close tasks" onClick={onClose} autoFocus />
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

        {!staged ? (
          <div className="tasks__placeholder">
            {ladder.kind === "refusal" ? (
              <span className="tasks__placeholder-title kd-selectable" role="alert">
                {ladder.message}
              </span>
            ) : (
              <>
                <span className="tasks__placeholder-title">{LADDER_WORDS[ladder.kind].title}</span>
                {LADDER_WORDS[ladder.kind].hint && <span>{LADDER_WORDS[ladder.kind].hint}</span>}
              </>
            )}
          </div>
        ) : (
          <div className="tasks__stage">
            {/* Wide: the task fills the stage and the board is put away —
                not hidden under it, gone until the person comes back. */}
            {!board.wide && (
            <div className="tasks__main">
              {ladder.kind === "empty" ? (
                <div className="tasks__placeholder">
                  <span className="tasks__placeholder-title">{LADDER_WORDS.empty.title}</span>
                  <span>{LADDER_WORDS.empty.hint}</span>
                </div>
              ) : board.mode === "board" ? (
                <BoardColumns
                  columns={board.columns}
                  selectedId={board.detail?.id ?? null}
                  drag={board.drag}
                  hover={board.hover}
                  onSelect={board.select}
                  onToggleColumn={board.toggleColumn}
                  onArm={board.armDrag}
                  onHover={board.hoverColumn}
                  onDrop={board.dropOn}
                />
              ) : (
                <QueuesLanes lanes={board.lanes} selectedId={board.detail?.id ?? null} onSelect={board.select} />
              )}
            </div>
            )}
            {panel}
          </div>
        )}
      </div>
    </ModalOverlay>
  );
}
