import { formatAge } from "../../domain/usage";
import {
  TASK_CAPS,
  USER_ACTOR,
  issuable,
  labelsOf,
  reachableStatuses,
  tasksOfTeam,
  unblocks,
  type Task,
  type TaskBoard,
  type TaskPriority,
  type TaskStatus,
} from "../../domain/tasks";
import type { StatusRingProps } from "@keepdeck/ui-kit/StatusRing";
import { blockerChip, statusMark, type BlockerChip } from "./taskCardView";
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
  /** The status's ring beside the label. */
  ring: StatusRingProps;
}

export interface TaskDetailView {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** `task-4 · In progress · by you · updated 25m ago` — the head's one
   * line, after the status dot. */
  meta: string;
  /** The status's ring in the head. */
  statusRing: StatusRingProps;
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
  /** Each blocker with where it stands; a resolved one (done, cancelled,
   * gone) holds nothing and is struck through. */
  blockers: BlockerChip[];
  blockersEmpty: string | null;
  unblocks: { id: string; title: string }[];
  /** Attached artifacts, titled when the registry knows them; a slug the
   * registry no longer holds is still shown — the task said so. */
  artifacts: { slug: string; title: string; known: boolean; openTitle: string; detachLabel: string }[];
  /** The task's labels, each with the name of its × . */
  labels: { label: string; removeLabel: string }[];
  /** The team's other labels — what the add field offers first. Free text
   * is a label too: the vocabulary is whatever tasks carry. */
  labelOptions: string[];
  /** Null while another label fits; the words for why not when full. */
  labelsFull: string | null;
  /** The workspace's artifacts not yet on this task — what may be attached. */
  attachOptions: ChoiceView[];
  /** Nothing published to attach: a one-word value, the reason in its
   * tooltip. Null when the workspace has artifacts. */
  attachEmpty: { text: string; title: string } | null;
  /** What was said, oldest first — the task's substance, always shown,
   * the composer under it (`commentsOf`). */
  comments: CommentItem[];
  commentsEmpty: string | null;
  /** What was changed — the agents' stream of status, label and assignee
   * moves — under its heading, shut until opened (`changesOf`). */
  activity: { label: string; open: boolean };
  changes: FeedChange[];
  changesEmpty: string | null;
  /** The board keeps the last so many comments and changes, each list cut
   * on its own: at its limit (cut, or cut at the next entry) the list says
   * so — null while it is not. */
  commentsTrimmed: string | null;
  changesTrimmed: string | null;
  /** The composer's bound — the domain's, so the field cannot outgrow it. */
  commentMax: number;
}

export interface FeedChange {
  kind: "change";
  key: string;
  who: string;
  text: string;
  age: string;
}

export interface CommentItem {
  key: string;
  who: string;
  age: string;
  body: string;
}

/** Every word the panel says that is not the task's own — the component
 * maps these and spells nothing. */
export const TASK_DETAIL_WORDS = {
  panel: (id: string) => `Task ${id}`,
  close: "Close",
  blockers: "Blocked by",
  unblocks: "Unblocks",
  artifacts: "Artifacts",
  labels: "Labels",
  addLabel: "Add a label",
  labelPrompt: "+ label",
  labelsFull: (max: number) => `${max} labels — take one off to add another`,
  comments: "Comments",
  commentsEmpty: "Nothing said yet",
  activity: "Activity",
  changesEmpty: "Nothing changed yet",
  labelAdded: (label: string) => `added label ${label}`,
  labelRemoved: (label: string) => `removed label ${label}`,
  trimmed: (max: number, what: string) => `At the board's limit — it keeps only the last ${max} ${what}`,
  detach: "Detach",
  attach: "Attach artifact",
  attachPrompt: "Attach an artifact",
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
  /** The activity (`changesOf`) opened under its heading. */
  activityOpen = false,
): TaskDetailView {
  const ctx = { board, roster, at: now };
  const reachable = new Set(reachableStatuses(task, USER_ACTOR, ctx));
  const statusOptions = BOARD_ORDER.filter((to) => to === task.status || reachable.has(to)).map((to) => ({
    value: to,
    label: STATUS_LABEL[to],
    tone: statusTone(to),
    ring: statusMark(to),
  }));
  const assigneeValues = [...new Set([...roster, ...(task.assignee ? [task.assignee] : [])])];
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    meta: [task.id, STATUS_LABEL[task.status], `by ${personName(task.author)}`, `updated ${formatAge(task.updated, now)}`].join(
      " · ",
    ),
    statusRing: statusMark(task.status),
    body: task.body,
    bodyEmpty: task.body.trim() === "" ? "No brief — the title is all there is" : null,
    assignee: task.assignee ?? "",
    assigneeOptions: [
      POOL_CHOICE,
      ...assigneeValues.map((role) => ({ value: role, label: role })),
    ],
    priorityOptions: priorityChoices(),
    statusOptions,
    blockers: task.blockedBy.map((id) => blockerChip(board, id)),
    blockersEmpty:
      task.blockedBy.length > 0 ? null : task.status === "todo" && issuable(task, board) ? "none — can start now" : "none",
    unblocks: unblocks(task, board).map((other) => ({ id: other.id, title: other.title })),
    labels: task.labels.map((label) => ({ label, removeLabel: `Remove ${label}` })),
    labelOptions: labelsOf({ tasks: tasksOfTeam(board, task.teamId) }).filter((label) => !task.labels.includes(label)),
    labelsFull: task.labels.length >= TASK_CAPS.labelsMax ? TASK_DETAIL_WORDS.labelsFull(TASK_CAPS.labelsMax) : null,
    artifacts: task.artifacts.map((slug) => {
      const known = artifacts.find((artifact) => artifact.id === slug);
      return {
        slug,
        title: known?.title ?? slug,
        known: known !== undefined,
        // What a press does, then the durable half a teammate is given.
        openTitle: `${known ? "Open in the browser" : "No longer published"} — ${slug}`,
        detachLabel: `${TASK_DETAIL_WORDS.detach} ${slug}`,
      };
    }),
    attachOptions: artifacts
      .filter((artifact) => !task.artifacts.includes(artifact.id))
      .map((artifact) => ({ value: artifact.id, label: artifact.title })),
    // With every published artifact attached, the chips say it all.
    attachEmpty:
      artifacts.length === 0
        ? { text: "none", title: "Nothing published in this workspace yet — agents attach with task.update artifacts=<id>" }
        : null,
    comments: commentsOf(task, now),
    commentsEmpty: task.comments.length === 0 ? TASK_DETAIL_WORDS.commentsEmpty : null,
    activity: { label: TASK_DETAIL_WORDS.activity, open: activityOpen },
    changes: changesOf(task, now),
    changesEmpty: task.log.length === 0 ? TASK_DETAIL_WORDS.changesEmpty : null,
    commentsTrimmed:
      task.comments.length >= TASK_CAPS.commentsMax ? TASK_DETAIL_WORDS.trimmed(TASK_CAPS.commentsMax, "comments") : null,
    changesTrimmed: task.log.length >= TASK_CAPS.logMax ? TASK_DETAIL_WORDS.trimmed(TASK_CAPS.logMax, "changes") : null,
    commentMax: TASK_CAPS.commentMax,
  };
}

/** What was said, oldest first (the order the board keeps). */
export function commentsOf(task: Pick<Task, "comments">, now: number): CommentItem[] {
  return task.comments.map((comment) => ({
    key: `comment-${comment.n}`,
    who: personName(comment.from),
    age: formatAge(comment.at, now),
    body: comment.body,
  }));
}

/**
 * What was changed, oldest first, every entry — nothing folds: a fold hid
 * the very lines a reader opened the activity for.
 */
export function changesOf(task: Pick<Task, "log">, now: number): FeedChange[] {
  // A change's key is what it is — its moment and field, counted among
  // its twins — never its place: the log is cut from the front at its cap,
  // and a place-key re-keyed every line on each new entry.
  const seen = new Map<string, number>();
  return task.log.flatMap((entry) => {
    const base = `change-${entry.at}-${entry.field}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return changeItems(entry, n === 0 ? base : `${base}-${n}`, now);
  });
}

/** What one log entry says in the timeline — usually one line. A labels
 * entry holds the set before and after; the timeline says what moved: a
 * line per label put on or taken off ("added label ui"), never the two
 * sets side by side. */
function changeItems(entry: Task["log"][number], key: string, now: number): FeedChange[] {
  const line = (text: string, suffix = ""): FeedChange => ({
    kind: "change",
    key: key + suffix,
    who: personName(entry.from),
    text,
    age: formatAge(entry.at, now),
  });
  if (entry.field === "labels") {
    const before = labelSet(entry.was);
    const after = labelSet(entry.now);
    return [
      ...after.filter((label) => !before.includes(label)).map((label) => line(TASK_DETAIL_WORDS.labelAdded(label), `+${label}`)),
      ...before.filter((label) => !after.includes(label)).map((label) => line(TASK_DETAIL_WORDS.labelRemoved(label), `-${label}`)),
    ];
  }
  if (entry.field === "body") {
    return [line(`edited the brief (the previous version is kept in the log: ${entry.was?.length ?? 0} characters)`)];
  }
  return [line(`${entry.field}: ${entry.was ?? "—"} → ${entry.now ?? "—"}`)];
}

/** A logged label set ("a,b"; null for none) as its labels. */
function labelSet(joined: string | null): string[] {
  return joined === null ? [] : joined.split(",");
}
