/**
 * Questions asked of a whole board: which task comes next, what is in a
 * member's queue, what a card's footer counts. One answer each, so the
 * MCP commands and the board's surfaces cannot disagree.
 */
import type { RoleStanding } from "../mail/roles";
import {
  acceptsWork,
  isOpen,
  TASK_STATUSES,
  type Task,
  type TaskBoard,
  type TaskPriority,
  type TaskStatus,
} from "./model";
import { openBlockersOf, outlives, withRelations, withTasks } from "./relations";

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

/**
 * Whether a task may be handed out or taken: waiting in `todo` with every
 * blocker resolved. THE rule `task.next` (its head and its pool count)
 * and the claim both ask — a todo task with an open blocker stays in its column with a
 * mark, which is not the `blocked` status (that one is the assignee saying
 * "I am waiting").
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

/** What one member has waiting: its `todo` tasks in queue order. */
export function queueOf(board: TaskBoard, teamId: string, assignee: string | null): Task[] {
  return tasksOfTeam(board, teamId)
    .filter((task) => task.status === "todo" && task.assignee === assignee)
    .sort(compareQueue);
}

/** The head of a member's queue: its first issuable task, or null. */
export function nextFor(board: TaskBoard, teamId: string, assignee: string): Task | null {
  return queueOf(board, teamId, assignee).find((task) => issuable(task, board)) ?? null;
}

/** The pool's issuable tasks — what anyone on the team may take. */
export function poolOf(board: TaskBoard, teamId: string): Task[] {
  return queueOf(board, teamId, null).filter((task) => issuable(task, board));
}

/**
 * Everything on one member's plate: open tasks assigned to it, plus — for
 * a member who accepts work — the team's tasks waiting in review.
 */
export function mine(
  board: TaskBoard,
  teamId: string,
  role: string,
  standing: RoleStanding | null,
): Task[] {
  const accepts = acceptsWork(standing);
  return tasksOfTeam(board, teamId)
    .filter(
      (task) =>
        isOpen(task.status) &&
        (task.assignee === role || (accepts && task.status === "review")),
    )
    .sort(compareQueue);
}

export type StatusCounts = Record<TaskStatus, number>;

/** How many tasks stand in each status. */
export function countByStatus(tasks: readonly Task[]): StatusCounts {
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as StatusCounts;
  for (const task of tasks) counts[task.status] += 1;
  return counts;
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
