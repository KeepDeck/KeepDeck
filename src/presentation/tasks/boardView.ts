import {
  compareQueue,
  isOpen,
  type Task,
  type TaskBoard,
  type TaskStatus,
} from "../../domain/tasks";
import { taskCardView, type TaskCardView } from "./taskCardView";
import { BOARD_ORDER, STATUS_LABEL } from "./words";

export interface BoardColumnView {
  status: TaskStatus;
  label: string;
  count: number;
  cards: TaskCardView[];
  /** A closed column folded to its header — Done by default, Cancelled
   * always behind the filter; the count still shows. */
  collapsed: boolean;
  /** Whether the column offers Hide/Show at all: only a closed one. */
  foldable: boolean;
}

export interface BoardOptions {
  /** Whether the Cancelled column is on the board at all. */
  showCancelled: boolean;
  /** The person's explicit choices — folded or not — per closed column.
   * A column they never touched takes the default below. */
  folds: ReadonlyMap<TaskStatus, boolean>;
  now: number;
}

/**
 * The board: one column per status in board order. Open columns keep
 * queue order (priority, then age), so the top card is what would be
 * handed out next; closed columns read newest first, the way a history
 * does.
 */
export function boardView(tasks: readonly Task[], board: TaskBoard, options: BoardOptions): BoardColumnView[] {
  // The DEFAULT for a closed column: folded while there is open work to
  // look at, unfolded when there is none — a board whose every task is
  // done showed five empty columns and a folded Done. A default only: the
  // person's own Hide or Show outranks it either way.
  const anyOpen = tasks.some((task) => isOpen(task.status));
  return BOARD_ORDER.filter((status) => status !== "cancelled" || options.showCancelled).map((status) => {
    const inColumn = tasks.filter((task) => task.status === status);
    const ordered = isOpen(status)
      ? [...inColumn].sort(compareQueue)
      : [...inColumn].sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
    return {
      status,
      label: STATUS_LABEL[status],
      count: inColumn.length,
      cards: ordered.map((task) => taskCardView(task, board, options.now)),
      collapsed: !isOpen(status) && (options.folds.get(status) ?? anyOpen),
      foldable: !isOpen(status),
    };
  });
}
