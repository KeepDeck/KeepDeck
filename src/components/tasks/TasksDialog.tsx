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
  useEscape(onClose, canClose);
  const { ladder } = board;
  const staged = ladder.kind === "board" || ladder.kind === "empty";
  const panel = board.composing ? (
    <NewTaskForm view={board.form} onCreate={(input) => void board.create(input)} onCancel={board.cancelCompose} />
  ) : board.detail ? (
    <TaskDetail
      view={board.detail}
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
          {staged && (
            <div className="tasks__toolbar">
              {board.teams.length > 0 && board.teamId !== null && (
                <Dropdown
                  ariaLabel="Team"
                  className="tasks__team"
                  options={board.teams.map((team) => ({ value: team.id, label: `Team · ${team.name}` }))}
                  value={board.teamId}
                  onChange={board.selectTeam}
                />
              )}
              <div className="form__types" role="group" aria-label="View">
                {MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    className={`form__type${board.mode === mode.value ? " form__type--active" : ""}`}
                    onClick={() => board.setMode(mode.value)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              {board.mode === "board" && (
                <button
                  type="button"
                  className={`form__type tasks__filter${board.showDropped ? " form__type--active" : ""}`}
                  aria-pressed={board.showDropped}
                  onClick={board.toggleDropped}
                >
                  Show dropped
                </button>
              )}
              <Button size="sm" variant="primary" onClick={board.compose} disabled={board.teamId === null}>
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
          <div className={`tasks__stage${panel ? " tasks__stage--panel" : ""}`}>
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
                  onSelect={board.select}
                  onToggleColumn={board.toggleColumn}
                />
              ) : (
                <QueuesLanes lanes={board.lanes} selectedId={board.detail?.id ?? null} onSelect={board.select} />
              )}
            </div>
            {panel}
          </div>
        )}
      </div>
    </ModalOverlay>
  );
}
