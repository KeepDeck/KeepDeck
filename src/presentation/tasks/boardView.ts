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
}

/**
 * The board: one column per status in board order. Open columns keep
 * queue order (priority, then age), so the top card is what would be
 * handed out next; closed columns read newest first, the way a history
 * does.
 */
export function boardView(tasks: readonly Task[], board: TaskBoard, now: number): BoardColumnView[] {
  return BOARD_ORDER.map((status) => {
    const inColumn = tasks.filter((task) => task.status === status);
    const ordered = isOpen(status)
      ? [...inColumn].sort(compareQueue)
      : [...inColumn].sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
    return {
      status,
      label: STATUS_LABEL[status],
      count: inColumn.length,
      cards: ordered.map((task) => taskCardView(task, board, now)),
    };
  });
}

/** A column's heading classes: the label, in its status's hue. */
export function columnLabelClassName(status: TaskStatus): string {
  return `tasks__column-label tasks__column-label--${status}`;
}
