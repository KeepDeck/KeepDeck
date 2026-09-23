import { formatAge } from "../../domain/usage";
import {
  TASK_CAPS,
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
  BOARD_ORDER,
  POOL_CHOICE,
  STATUS_LABEL,
  priorityChoices,
  type ChoiceView,
  personName,
  statusTone,
  type StatusTone,
} from "./words";

/** A status the person may pick — where the task stands, and every rung
 * the transition table lets them move it to from here. */
export interface StatusChoiceView extends ChoiceView {
  value: TaskStatus;
  tone: StatusTone;
  /** The dot beside the label, in the status's hue. */
  dotClassName: string;
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
  /** Attached artifacts, titled when the registry knows them; a slug the
   * registry no longer holds is still shown — the task said so. */
  artifacts: { slug: string; title: string; known: boolean; openTitle: string; detachLabel: string }[];
  /** The workspace's artifacts not yet on this task — what may be attached. */
  attachOptions: ChoiceView[];
  attachEmpty: string | null;
  thread: { n: number; who: string; age: string; body: string }[];
  threadEmpty: string | null;
  /** The composer's bound — the domain's, so the field cannot outgrow it. */
  commentMax: number;
  log: { who: string; text: string; age: string }[];
}

/** Every word the panel says that is not the task's own — the component
 * maps these and spells nothing. */
export const TASK_DETAIL_WORDS = {
  panel: (id: string) => `Task ${id}`,
  close: "Close",
  blockers: "Blockers",
  unblocks: "Unblocks",
  artifacts: "Artifacts",
  thread: "Thread",
  log: "Log",
  detach: "Detach",
  attach: "Attach artifact",
  attachPrompt: "Attach an artifact…",
  commentPlaceholder: "Add a comment — it stays with the task",
  comment: "Comment",
} as const;

/** What a pick in the status picker asks for: a move, or nothing when the
 * person picked where the task already stands. */
export function pickedStatus(current: TaskStatus, picked: string): TaskStatus | null {
  return picked === current ? null : (picked as TaskStatus);
}

/** What a pick in the attach picker asks for: the artifact, or nothing for
 * the prompt line at its head. */
export function pickedArtifact(picked: string): string | null {
  return picked === "" ? null : picked;
}

/** The panel's classes: wide while the task fills the stage. */
export function taskDetailClassName(wide: boolean): string {
  return wide ? "tasks__detail tasks__detail--wide" : "tasks__detail";
}

/** An artifact as the registry lists it — the two facts a task needs. */
export interface ArtifactRef {
  id: string;
  title: string;
}

export function taskDetailView(
  task: Task,
  board: TaskBoard,
  roster: readonly string[],
  now: number,
  /** The workspace's artifacts, as the registry lists them; empty when the
   * feature is off or nothing is published. */
  artifacts: readonly ArtifactRef[] = [],
): TaskDetailView {
  const ctx = { board, roster, at: now };
  const reachable = new Set(reachableStatuses(task, USER_ACTOR, ctx));
  const statusOptions = BOARD_ORDER.filter((to) => to === task.status || reachable.has(to)).map((to) => ({
    value: to,
    label: STATUS_LABEL[to],
    tone: statusTone(to),
    dotClassName: `tasks__status-dot tasks__status-dot--${statusTone(to)}`,
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
      POOL_CHOICE,
      ...assigneeValues.map((role) => ({ value: role, label: role })),
    ],
    priorityOptions: priorityChoices(),
    statusOptions,
    blockers: task.blockedBy.map((id) => {
      const blocker = findTask(board, id);
      return { id, text: `${id} · ${blocker ? STATUS_LABEL[blocker.status].toLowerCase() : "gone"}` };
    }),
    blockersEmpty:
      task.blockedBy.length > 0 ? null : task.status === "todo" && issuable(task, board) ? "none — can start now" : "none",
    unblocks: unblocks(task, board).map((other) => ({ id: other.id, title: other.title })),
    artifacts: task.artifacts.map((slug) => {
      const known = artifacts.find((artifact) => artifact.id === slug);
      return {
        slug,
        title: known?.title ?? slug,
        known: known !== undefined,
        openTitle: known ? "Open in the browser" : "No longer published",
        detachLabel: `${TASK_DETAIL_WORDS.detach} ${slug}`,
      };
    }),
    attachOptions: artifacts
      .filter((artifact) => !task.artifacts.includes(artifact.id))
      .map((artifact) => ({ value: artifact.id, label: artifact.title })),
    attachEmpty:
      artifacts.length === 0
        ? "Nothing published in this workspace yet — agents attach with task.update artifacts=<id>"
        : artifacts.every((artifact) => task.artifacts.includes(artifact.id))
          ? "Every artifact of this workspace is attached"
          : null,
    thread: task.comments.map((comment) => ({
      n: comment.n,
      who: personName(comment.from),
      age: formatAge(comment.at, now),
      body: comment.body,
    })),
    threadEmpty: task.comments.length === 0 ? "No comments yet" : null,
    commentMax: TASK_CAPS.commentMax,
    log: task.log.map((entry) => ({
      who: personName(entry.from),
      text:
        entry.field === "body"
          ? `edited the brief (the previous version is kept in the log: ${entry.was?.length ?? 0} characters)`
          : `${entry.field}: ${entry.was ?? "—"} → ${entry.now ?? "—"}`,
      age: formatAge(entry.at, now),
    })),
  };
}
