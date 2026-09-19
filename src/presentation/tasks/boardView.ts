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
}

export interface BoardOptions {
  /** Whether the Cancelled column is on the board at all. */
  showCancelled: boolean;
  /** Closed columns the person unfolded. */
  expanded: ReadonlySet<TaskStatus>;
  now: number;
}

/**
 * The board: one column per status in board order. Open columns keep
 * queue order (priority, then age), so the top card is what would be
 * handed out next; closed columns read newest first, the way a history
 * does.
 */
export function boardView(tasks: readonly Task[], board: TaskBoard, options: BoardOptions): BoardColumnView[] {
  // Closed columns fold only while there is open work to look at: a board
  // whose every task is done showed five empty columns and a folded Done.
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
      collapsed: !isOpen(status) && anyOpen && !options.expanded.has(status),
    };
  });
}
