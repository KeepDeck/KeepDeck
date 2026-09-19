import { Dropdown } from "@keepdeck/ui-kit";
import type { Workspace } from "../../domain/deck";
import { LADDER_WORDS } from "../../presentation/tasks";
import { Button } from "../../ui/Button";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useWallClock } from "../../ui/useWallClock";
import { BoardColumns } from "./BoardColumns";
import { NewTaskForm } from "./NewTaskForm";
import { QueuesLanes } from "./QueuesLanes";
import { TaskDetail } from "./TaskDetail";
import { useTasksBoard, type TasksAccess, type TasksMode } from "./useTasksBoard";

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
}

const MODES: readonly { value: TasksMode; label: string }[] = [
  { value: "board", label: "Board" },
  { value: "queues", label: "Queues" },
];

/**
 * The Tasks dialog — the person's view of a team's board: the ladder as
 * columns, or the load as lanes per member, with one task open on the
 * right. The shell renders and emits; every transition is the hook's and
 * every word the presentation's.
 */
export function TasksDialog({ tasks, workspace, focus, onFocus, onClose, canClose = true }: TasksDialogProps) {
  const now = useWallClock(0, true);
  const board = useTasksBoard(tasks, workspace, focus, onFocus, now);
  // Escape peels one layer: the form when it is open, then the wide view
  // back to the board, then the dialog. Closing the whole dialog out from
  // under a half-typed brief is the one thing the key must never do.
  useEscape(() => {
    if (board.composing) board.cancelCompose();
    else if (board.wide) board.narrow();
    else if (board.detail) board.close();
    else onClose();
  }, canClose);
  const { ladder } = board;
  const staged = ladder.kind === "board" || ladder.kind === "empty";
  const panel = board.composing ? (
    <NewTaskForm view={board.form} onCreate={(input) => void board.create(input)} onCancel={board.cancelCompose} />
  ) : board.detail ? (
    <TaskDetail
      view={board.detail}
      wide={board.wide}
      onToggleWide={board.toggleWide}
      onClose={board.close}
      onMove={board.move}
      onAssign={board.assign}
      onPriority={board.setPriority}
      onComment={board.comment}
      onSelect={board.select}
    />
  ) : null;

  return (
    <ModalOverlay>
      <div className="form tasks" role="dialog" aria-modal="true" aria-label="Tasks">
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
                {MODES.map((mode) => (
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
          <div
            className={`tasks__stage${panel ? " tasks__stage--panel" : ""}${board.composing ? " tasks__stage--compose" : ""}${board.wide ? " tasks__stage--wide" : ""}`}
          >
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
                <>
                  <BoardColumns
                    columns={board.columns}
                    selectedId={board.detail?.id ?? null}
                    onSelect={board.select}
                    onToggleColumn={board.toggleColumn}
                  />
                  {/* Beside the board, where its column appears — not in
                      the bar, which must not change with the view. */}
                  <div className="tasks__board-foot">
                    <button
                      type="button"
                      className="tasks__column-toggle"
                      aria-pressed={board.showCancelled}
                      onClick={board.toggleCancelled}
                    >
                      {board.showCancelled ? "Hide cancelled" : "Show cancelled"}
                    </button>
                  </div>
                </>
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
