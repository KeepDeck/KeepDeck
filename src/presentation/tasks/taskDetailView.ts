import { formatAge } from "../../domain/usage";
import {
  USER_ACTOR,
  findTask,
  issuable,
  reachableStatuses,
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
  statusTone,
  type StatusTone,
} from "./words";

export interface ChoiceView {
  value: string;
  label: string;
}

/** A status the person may pick — where the task stands, and every rung
 * the transition table lets them move it to from here. */
export interface StatusChoiceView extends ChoiceView {
  value: TaskStatus;
  tone: StatusTone;
}

export interface TaskDetailView {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** `task-4 · by you · opened 40m ago · updated 25m ago` */
  meta: string;
  body: string;
  bodyEmpty: string | null;
  /** The pool first, then the roster — and the current assignee even off
   * the roster, so the control can show what the task says. */
  assignee: string;
  assigneeOptions: ChoiceView[];
  priorityOptions: ChoiceView[];
  /** What the status picker offers: where the task stands, then where the
   * PERSON may move it — the transition table's answer, in ladder order,
   * never a list spelled in markup. */
  statusOptions: StatusChoiceView[];
  blockers: { id: string; text: string }[];
  blockersEmpty: string | null;
  unblocks: { id: string; title: string }[];
  artifacts: string[];
  thread: { n: number; who: string; age: string; body: string }[];
  threadEmpty: string | null;
  log: { who: string; text: string; age: string }[];
}

/** The ladder's order — how the status picker lists what it offers. */
const LADDER: readonly TaskStatus[] = ["todo", "doing", "blocked", "review", "done", "cancelled"];

export function taskDetailView(
  task: Task,
  board: TaskBoard,
  roster: readonly string[],
  now: number,
): TaskDetailView {
  const ctx = { board, roster, at: now };
  const reachable = new Set(reachableStatuses(task, USER_ACTOR, ctx));
  const statusOptions = LADDER.filter((to) => to === task.status || reachable.has(to)).map((to) => ({
    value: to,
    label: STATUS_LABEL[to],
    tone: statusTone(to),
  }));
  const assigneeValues = [...new Set([...roster, ...(task.assignee ? [task.assignee] : [])])];
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
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
    statusOptions,
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
