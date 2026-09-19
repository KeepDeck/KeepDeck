import { formatAge } from "../../domain/usage";
import {
  USER_ACTOR,
  findTask,
  issuable,
  transition,
  unblocks,
  type Task,
  type TaskBoard,
  type TaskPriority,
  type TaskStatus,
} from "../../domain/tasks";
import {
  PRIORITY_LABEL,
  POOL_LABEL,
  STATUS_LABEL,
  personName,
  priorityMark,
  statusTone,
  type StatusTone,
} from "./words";

export interface MoveView {
  to: TaskStatus;
  label: string;
  /** The one move that closes the loop — drawn as the primary action. */
  primary: boolean;
}

export interface ChoiceView {
  value: string;
  label: string;
}

export interface TaskDetailView {
  id: string;
  title: string;
  statusLabel: string;
  tone: StatusTone;
  priority: TaskPriority;
  priorityMark: string | null;
  /** `task-4 · by you · opened 40m ago · updated 25m ago` */
  meta: string;
  body: string;
  bodyEmpty: string | null;
  /** The pool first, then the roster — and the current assignee even off
   * the roster, so the control can show what the task says. */
  assignee: string;
  assigneeOptions: ChoiceView[];
  priorityOptions: ChoiceView[];
  /** The moves the PERSON may make from here — the transition table's
   * answer, never a list spelled in markup. */
  moves: MoveView[];
  blockers: { id: string; text: string }[];
  blockersEmpty: string | null;
  unblocks: { id: string; title: string }[];
  artifacts: string[];
  thread: { n: number; who: string; age: string; body: string }[];
  threadEmpty: string | null;
  log: { who: string; text: string; age: string }[];
}

/** What a move is called, from where it starts. */
function moveLabel(from: TaskStatus, to: TaskStatus): string {
  if (to === "dropped") return "Drop";
  if (to === "done") return "Accept";
  if (to === "review") return "Finish — to review";
  if (to === "blocked") return "Block";
  if (to === "todo") return "Reopen";
  // to === "doing"
  if (from === "review") return "Return — to doing";
  if (from === "blocked") return "Unblock — doing";
  return "Start — doing";
}

/** The order moves are offered in: forward first, then back, then out. */
const MOVE_ORDER: readonly TaskStatus[] = ["doing", "review", "done", "blocked", "todo", "dropped"];

export function taskDetailView(
  task: Task,
  board: TaskBoard,
  roster: readonly string[],
  now: number,
): TaskDetailView {
  const ctx = { board, roster, at: now };
  const moves = MOVE_ORDER.filter((to) => to !== task.status)
    .filter((to) => transition(task, { kind: "status", to }, USER_ACTOR, ctx).ok)
    .map((to) => ({ to, label: moveLabel(task.status, to), primary: to === "done" || (to === "doing" && task.status === "todo") }));
  const assigneeValues = [...new Set([...roster, ...(task.assignee ? [task.assignee] : [])])];
  return {
    id: task.id,
    title: task.title,
    statusLabel: STATUS_LABEL[task.status],
    tone: statusTone(task.status),
    priority: task.priority,
    priorityMark: priorityMark(task.priority),
    meta: [
      task.id,
      `by ${personName(task.author)}`,
      `opened ${formatAge(task.created, now)}`,
      `updated ${formatAge(task.updated, now)}`,
    ].join(" · "),
    body: task.body,
    bodyEmpty: task.body.trim() === "" ? "No brief — the title is all there is" : null,
    assignee: task.assignee ?? "",
    assigneeOptions: [
      { value: "", label: `${POOL_LABEL} — unassigned` },
      ...assigneeValues.map((role) => ({ value: role, label: role })),
    ],
    priorityOptions: (["high", "normal", "low"] as const).map((value) => ({ value, label: PRIORITY_LABEL[value] })),
    moves,
    blockers: task.blockedBy.map((id) => {
      const blocker = findTask(board, id);
      return { id, text: `${id} · ${blocker ? STATUS_LABEL[blocker.status].toLowerCase() : "gone"}` };
    }),
    blockersEmpty:
      task.blockedBy.length > 0 ? null : task.status === "todo" && issuable(task, board) ? "none — can start now" : "none",
    unblocks: unblocks(task, board).map((other) => ({ id: other.id, title: other.title })),
    artifacts: [...task.artifacts],
    thread: task.comments.map((comment) => ({
      n: comment.n,
      who: personName(comment.from),
      age: formatAge(comment.at, now),
      body: comment.body,
    })),
    threadEmpty: task.comments.length === 0 ? "No comments yet" : null,
    log: task.log.map((entry) => ({
      who: personName(entry.from),
      text:
        entry.field === "body"
          ? "edited the brief"
          : `${entry.field}: ${entry.was ?? "—"} → ${entry.now ?? "—"}`,
      age: formatAge(entry.at, now),
    })),
  };
}
