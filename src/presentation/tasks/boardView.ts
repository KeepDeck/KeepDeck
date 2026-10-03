import type { Task, TaskBoard, TaskStatus } from "../../domain/tasks";
import { tasksInStatus, type TaskQuery } from "./queryView";
import { taskCardView, type TaskCardView } from "./taskCardView";
import { BOARD_ORDER, STATUS_LABEL } from "./words";

export interface BoardColumnView {
  status: TaskStatus;
  label: string;
  count: number;
  cards: TaskCardView[];
}

/**
 * The board: one column per status in board order, each the query's set
 * of that status in the tracker's one order (`queryView`).
 */
export function boardView(
  tasks: readonly Task[],
  board: TaskBoard,
  now: number,
  query: TaskQuery,
): BoardColumnView[] {
  return BOARD_ORDER.map((status) => {
    const shown = tasksInStatus(tasks, status, query);
    return {
      status,
      label: STATUS_LABEL[status],
      count: shown.length,
      cards: shown.map((task) => taskCardView(task, board, now)),
    };
  });
}

/** A column's heading classes: the label, in its status's hue. */
export function columnLabelClassName(status: TaskStatus): string {
  return `tasks__column-label tasks__column-label--${status}`;
}
