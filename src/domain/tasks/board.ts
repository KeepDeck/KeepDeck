/**
 * Questions asked of a whole board: what can start, what waits on a
 * decision, what a card's footer counts. One answer each, so the MCP
 * commands and the board's surfaces cannot disagree.
 */
import {
  TASK_STATUSES,
  isOpen,
  type Task,
  type TaskBoard,
  type TaskPriority,
  type TaskStatus,
} from "./model";
import { openBlockersOf, outlives, tasksOfEpic, withRelations, withTasks } from "./relations";

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

/**
 * Whether a task may be handed out or taken: waiting in `todo` with every
 * blocker resolved. THE rule every answer's `issuable` and the start of a
 * task both ask — a todo task with an open blocker stays in its column
 * with a mark, which is not the `blocked` status (that one is the assignee
 * saying "I am waiting").
 */
export function issuable(task: Task, board: TaskBoard): boolean {
  return task.status === "todo" && openBlockersOf(task, board).length === 0;
}

/** Queue order: higher priority first, then the older task, then the id
 * as a total tiebreak — two tasks created in one millisecond must not
 * swap places between two reads. */
export function compareQueue(a: Task, b: Task): number {
  const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (rank !== 0) return rank;
  if (a.created !== b.created) return a.created - b.created;
  return a.id.localeCompare(b.id);
}

/**
 * The board with only the tasks of `teamIds` — a team the deck no longer
 * has takes its tasks with it (the user's decision: a disbanded team's
 * board is deleted, not archived). Ids are never handed out again: the
 * counter stays where it is. Their links go too, but for the facts that
 * outlive an end (a copy's source). The SAME board when nothing goes, so
 * a caller can tell a change from none by reference.
 */
export function keepTeams(board: TaskBoard, teamIds: ReadonlySet<string>): TaskBoard {
  if (board.tasks.every((task) => teamIds.has(task.teamId))) return board;
  const gone = new Set(board.tasks.filter((task) => !teamIds.has(task.teamId)).map((task) => task.uid));
  // Their links go with them, each kind as its rule says (`outlives`).
  const kept = withTasks(board, board.tasks.filter((task) => !gone.has(task.uid)));
  return withRelations(kept, board.relations.filter((relation) => outlives(relation, gone)));
}

/** A team's tasks, in board order. */
export function tasksOfTeam(board: TaskBoard, teamId: string): Task[] {
  return board.tasks.filter((task) => task.teamId === teamId);
}

/**
 * What waits on whoever hands out work, most urgent first: the team's
 * tasks in review (to accept or send back) and the ones blocked (to
 * unblock or rethink). Nothing else on the board needs that decision.
 */
export function awaitingDecision(board: TaskBoard, teamId: string): Task[] {
  return tasksOfTeam(board, teamId)
    .filter((task) => task.status === "review" || task.status === "blocked")
    .sort(compareQueue);
}

export type StatusCounts = Record<TaskStatus, number>;

/** How many tasks stand in each status. */
export function countByStatus(tasks: readonly Task[]): StatusCounts {
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as StatusCounts;
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}

/** How far an epic has come: its tasks done, still open, and cancelled.
 * Read from the board each time, never stored; the work an epic counts is
 * its done and its open — a cancelled task was taken off, not finished. */
export interface EpicProgress {
  done: number;
  open: number;
  cancelled: number;
}

/** Whether open work may stand under `epic`: it is open itself. The one
 * test behind "a closed epic holds no open work", from whichever side the
 * family rules ask it. */
export function admitsOpenWork(epic: Task): boolean {
  return isOpen(epic.status);
}

/** The tasks under `epic` still open — THE question the rule "a closed
 * epic holds no open work" asks, from whichever side it is asked: the
 * epic closing, or work entering a closed one. In board order. */
export function openWorkUnder(epic: Task, board: TaskBoard): Task[] {
  return tasksOfEpic(epic, board).filter((task) => isOpen(task.status));
}

export function epicProgress(epic: Task, board: TaskBoard): EpicProgress {
  const progress = { done: 0, open: 0, cancelled: 0 };
  for (const task of tasksOfEpic(epic, board)) {
    if (task.status === "done") progress.done += 1;
    else if (task.status === "cancelled") progress.cancelled += 1;
    else progress.open += 1;
  }
  return progress;
}

/** The labels a board's tasks carry, most used first (then by name) — the
 * board's whole vocabulary, derived and never stored: a label exists while
 * a task carries it, and is gone when the last one drops it. */
export function labelsOf(board: Pick<TaskBoard, "tasks">): string[] {
  const counts = new Map<string, number>();
  for (const task of board.tasks) {
    for (const label of task.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .map(([label]) => label);
}
