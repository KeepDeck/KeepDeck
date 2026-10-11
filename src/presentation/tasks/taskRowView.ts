import { formatAge } from "../../domain/usage";
import { blockerResolved, blockersOf, epicCounts, progressOf, type StatusCounts, type Task, type TaskBoard, type TaskStatus } from "../../domain/tasks";
import type { StatusBarPart } from "@keepdeck/ui-kit/StatusBar";
import type { StatusRingProps } from "@keepdeck/ui-kit/StatusRing";
import { BOARD_ORDER, EPIC_CHIP, POOL_LABEL, STATUS_LABEL, priorityMark, statusTone, type StatusTone } from "./words";

/** One task as a list row says it, in columns: priority, status, id,
 * title, labels, what holds it, who has it, how long since it moved. */
export interface TaskRowView {
  id: string;
  title: string;
  priority: string | null;
  tone: StatusTone;
  /** Struck through and dimmed: taken off the board without being done. */
  cancelled: boolean;
  /** The task's labels, as words — no colour: colour is state. */
  labels: readonly string[];
  assignee: string;
  age: string;
  /** The status as a small ring, filled as far as the ladder has come. */
  ring: StatusRingProps;
  /** Every blocker named, each as a chip: standing (the failed hue) or
   * resolved (struck — it holds nothing). */
  blockerChips: BlockerChip[];
  /** An epic's mark and how far it has come; null for work. */
  epic: EpicMarkView | null;
}

/** What says a row is an epic: its chip, and its progress as a count and
 * a bar — done of the work it counts (cancelled work is not counted). */
export interface EpicMarkView {
  chip: string;
  /** `2/5`. */
  count: string;
  /** The bar: each status with a hue, its share of the counted work. */
  parts: StatusBarPart[];
  /** `2 of 5 tasks done — 1 review, 1 to do`, for a reader. */
  label: string;
  /** `2 of 5 done`, the card's line. */
  summary: string;
}

/** The order an epic's statuses are told in, bar and words alike: the
 * board's own, read from its finished end. Cancelled work is not counted. */
const EPIC_ORDER: readonly TaskStatus[] = [...BOARD_ORDER].reverse().filter((status) => status !== "cancelled");

/** An epic's mark from its tasks' counts (`epicCounts`). The bar paints
 * the statuses that wear a hue; the rest of the counted work (to do,
 * backlog) is the bare track, and is named only in the words. */
export function epicMark(counts: StatusCounts): EpicMarkView {
  const { done, open } = progressOf(counts);
  const counted = done + open;
  const present = EPIC_ORDER.filter((status) => counts[status] > 0);
  const parts = present.flatMap((status): StatusBarPart[] => {
    const tone = statusTone(status);
    return tone === "none" ? [] : [{ tone, share: (counts[status] * 100) / counted }];
  });
  const rest = present.filter((status) => status !== "done").map((status) => `${counts[status]} ${STATUS_LABEL[status].toLowerCase()}`);
  const head = `${done} of ${counted} tasks done`;
  return {
    chip: EPIC_CHIP,
    count: `${done}/${counted}`,
    parts,
    label: rest.length === 0 ? head : `${head} — ${rest.join(", ")}`,
    summary: `${done} of ${counted} done`,
  };
}

/** One blocker as a chip: where it stands, and whether it still holds. */
export interface BlockerChip {
  id: string;
  /** `task-1 · in progress`. */
  text: string;
  resolved: boolean;
  className: string;
}

/** THE blocker chip — a row's, the open task's — for a blocker
 * on this board (one that is not has no key here to show; task-224). A
 * resolved one (done, cancelled) holds nothing and is struck through. */
export function blockerChip(blocker: Task): BlockerChip {
  const resolved = blockerResolved(blocker.status);
  return {
    id: blocker.id,
    text: `${blocker.id} · ${STATUS_LABEL[blocker.status].toLowerCase()}`,
    resolved,
    className: resolved ? "kd-tag kd-tag--outline tasks__tag--resolved" : "kd-tag kd-tag--outline tasks__tag--blocking",
  };
}

/** How far along each status stands on the ladder, as a ring's fill. */
const LADDER_FILL: Record<TaskStatus, number> = {
  backlog: 0,
  todo: 0,
  blocked: 0,
  "in-progress": 50,
  review: 75,
  done: 100,
  cancelled: 100,
};

/** A status as the tracker's ring (ui-kit StatusRing): filled by its place
 * on the ladder, in the status hue `statusTone` names — cancelled a grey
 * disc, blocked barred. */
export function statusRing(status: TaskStatus): StatusRingProps {
  return {
    fill: LADDER_FILL[status],
    tone: statusTone(status),
    barred: status === "blocked",
    dashed: status === "backlog",
    label: STATUS_LABEL[status],
  };
}

/** A status's ring beside its own word — a heading, a picker's option,
 * the open task's meta line: the word names it, the ring only pictures. */
export function statusMark(status: TaskStatus): StatusRingProps {
  return { ...statusRing(status), decorative: true };
}

export function taskRowView(task: Task, board: TaskBoard, now: number): TaskRowView {
  return {
    id: task.id,
    title: task.title,
    priority: priorityMark(task.priority),
    tone: statusTone(task.status),
    cancelled: task.status === "cancelled",
    labels: task.labels,
    assignee: task.assignee ?? POOL_LABEL,
    age: formatAge(task.updated, now),
    ring: statusRing(task.status),
    blockerChips: blockersOf(task, board).map(blockerChip),
    epic: task.kind === "epic" ? epicMark(epicCounts(task, board)) : null,
  };
}
