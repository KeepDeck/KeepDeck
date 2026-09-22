/**
 * Questions asked of a whole board: which task comes next, what is in a
 * queue, what a card's footer counts. One answer each, so the MCP
 * commands, the Queues view and the door badge cannot disagree.
 */
import type { RoleStanding } from "../mail/roles";
import {
  acceptsWork,
  blockerResolved,
  isOpen,
  type Task,
  type TaskBoard,
  type TaskPriority,
  type TaskStatus,
} from "./model";

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

/** The task with `id`, if the board holds it. */
export function findTask(board: TaskBoard, id: string): Task | undefined {
  return board.tasks.find((task) => task.id === id);
}

/**
 * The blockers of `task` that still stand: named tasks that are open. An id
 * the board does not hold is treated as resolved — a task is never deleted,
 * so such an id can only come from a hand-edited file, and a phantom that
 * blocks forever is the worse failure.
 */
export function openBlockersOf(task: Task, board: TaskBoard): string[] {
  return task.blockedBy.filter((id) => {
    const blocker = findTask(board, id);
    return blocker !== undefined && !blockerResolved(blocker.status);
  });
}

/**
 * Whether a task may be handed out or taken: waiting in `todo` with every
 * blocker resolved. THE rule `task.next`, the Queues view and the claim
 * all ask — a todo task with an open blocker stays in its column with a
 * mark, which is not the `blocked` status (that one is the assignee saying
 * "I am waiting").
 */
export function issuable(task: Task, board: TaskBoard): boolean {
  return task.status === "todo" && openBlockersOf(task, board).length === 0;
}

/** The tasks `blocked by` this one — the reverse edge, derived, never
 * stored. What accepting a prerequisite releases. */
export function unblocks(task: Task, board: TaskBoard): Task[] {
  return board.tasks.filter((other) => other.blockedBy.includes(task.id));
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

/** What one member is on right now — its `in-progress` tasks (normally one). */
export function currentOf(board: TaskBoard, teamId: string, assignee: string): Task[] {
  return tasksOfTeam(board, teamId)
    .filter((task) => task.status === "in-progress" && task.assignee === assignee)
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
  const counts: StatusCounts = { todo: 0, "in-progress": 0, blocked: 0, review: 0, done: 0, cancelled: 0 };
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}
