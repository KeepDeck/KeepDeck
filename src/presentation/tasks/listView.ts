/**
 * The tracker's list: a team's tasks in the tracker's one order
 * (`queryView`), as ONE windowed list — a heading per status, then that
 * status's rows, the groups in `BOARD_ORDER`.
 *
 * A folded group keeps its heading in the list (only its rows go): the
 * heading is the toggle that brings them back, and the windowed list may
 * be holding the reader's place on it — a key that vanished would hand
 * that place to a neighbour.
 *
 * An epic stands in the group of its own status, and every task under it
 * stands under it, one step in — closed ones too, in the order of the
 * groups and then the tracker's one order — not in the groups of their own
 * statuses (task-297, layout B1). Its own fold, like a group's, hides its
 * tasks and keeps its row.
 */
import type { StatusRingProps } from "@keepdeck/ui-kit/StatusRing";
import { epicOf, tasksOfEpic, type Task, type TaskBoard, type TaskStatus } from "../../domain/tasks";
import { dropStateOf, type RowGrip, type DragState } from "./rowDrag";
import { compareInStatus, matchesQuery, type TaskQuery } from "./queryView";
import { statusMark, taskRowView, type TaskRowView } from "./taskRowView";
import { BOARD_ORDER, STATUS_LABEL } from "./words";

/** Where an item stands in its group's drawn block — what edges of the
 * group's drop frame it draws: the heading opens it (`top`), or is all
 * of it when no rows show (`whole`); the last row closes it (`bottom`). */
export type GroupEdge = "whole" | "top" | "middle" | "bottom";

export interface ListHeading {
  kind: "head";
  key: string;
  status: TaskStatus;
  label: string;
  count: number;
  folded: boolean;
  ring: StatusRingProps;
  edge: GroupEdge;
}

export interface ListRow {
  kind: "row";
  key: string;
  /** The group it is in — where a drop on it lands. */
  status: TaskStatus;
  line: TaskRowView;
  /** The task open over the list right now. */
  open: boolean;
  className: string;
  edge: GroupEdge;
  /** 1 for a task under an epic, drawn one step in; 0 for the rest. */
  depth: 0 | 1;
  /** An epic's own fold, or null for a row that is no epic. */
  fold: { folded: boolean; label: string } | null;
}

export type ListItem = ListHeading | ListRow;

/** The words of an epic's fold, by what a press does. */
export const EPIC_FOLD_WORDS = { fold: "Hide the epic's tasks", unfold: "Show the epic's tasks" } as const;

/** The list's items: every status's heading, always — an empty group
 * with its 0 — and the rows of each open group: its tasks in the tracker's
 * one order, each epic with its tasks under it unless the epic is folded
 * (`foldedEpics`, by id). The query keeps a task under its epic, the epic
 * shown over it whether or not it matches itself; a heading counts every
 * row its group holds, an epic's tasks included, folded or not. */
export function listView(
  tasks: readonly Task[],
  board: TaskBoard,
  now: number,
  query: TaskQuery,
  folded: ReadonlySet<TaskStatus>,
  openId: string | null,
  foldedEpics: ReadonlySet<string> = NO_EPICS,
): ListItem[] {
  const here = new Set(tasks.map((task) => task.uid));
  const epicHere = (task: Task) => {
    const epic = epicOf(task, board);
    return epic !== null && here.has(epic.uid) ? epic : null;
  };
  // An epic's tasks, as the query shows them: by group, then queue order.
  const under = (epic: Task) =>
    tasksOfEpic(epic, board)
      .filter((task) => here.has(task.uid) && matchesQuery(task, query))
      .sort((a, b) => BOARD_ORDER.indexOf(a.status) - BOARD_ORDER.indexOf(b.status) || compareInStatus(a.status)(a, b));
  return BOARD_ORDER.flatMap((status): ListItem[] => {
    const tops = tasks
      .filter((task) => task.status === status && epicHere(task) === null)
      .map((task) => ({ task, kids: task.kind === "epic" ? under(task) : [] }))
      .filter(({ task, kids }) => matchesQuery(task, query) || kids.length > 0)
      .sort((a, b) => compareInStatus(status)(a.task, b.task));
    const count = tops.reduce((sum, top) => sum + 1 + top.kids.length, 0);
    const isFolded = folded.has(status);
    const heading: ListHeading = {
      kind: "head",
      key: `head:${status}`,
      status,
      label: STATUS_LABEL[status],
      count,
      folded: isFolded,
      ring: statusMark(status),
      edge: isFolded || count === 0 ? "whole" : "top",
    };
    if (isFolded) return [heading];
    const placed = tops.flatMap(({ task, kids }) => {
      const epicFolded = foldedEpics.has(task.id);
      const fold = task.kind === "epic" ? { folded: epicFolded, label: epicFolded ? EPIC_FOLD_WORDS.unfold : EPIC_FOLD_WORDS.fold } : null;
      return [
        { task, depth: 0 as const, fold },
        ...(epicFolded ? [] : kids.map((kid) => ({ task: kid, depth: 1 as const, fold: null }))),
      ];
    });
    return [
      heading,
      ...placed.map(({ task, depth, fold }, at) =>
        listRow(taskRowView(task, board, now), status, task.id === openId, at === placed.length - 1 ? "bottom" : "middle", depth, fold),
      ),
    ];
  });
}

const NO_EPICS: ReadonlySet<string> = new Set();

/** An item's identity in the windowed list — a task's id, a heading's
 * status; never an index. */
export function listItemKey(item: ListItem): string {
  return item.key;
}

/** First-paint height guesses: a heading and a one-line row. */
export const LIST_HEAD_ESTIMATE_PX = 30;
export const LIST_ROW_ESTIMATE_PX = 34;

export function listItemEstimate(item: ListItem): number {
  return item.kind === "head" ? LIST_HEAD_ESTIMATE_PX : LIST_ROW_ESTIMATE_PX;
}

/** Whether a list item starts a group — what the pinned heading is
 * pushed out by, and what `headingOf` walks back to. */
export function isListHeading(item: ListItem): item is ListHeading {
  return item.kind === "head";
}

/** The heading of the group the row at `index` is in — what the pinned
 * heading shows for the first row in view. Null before the first heading. */
export function headingOf(items: readonly ListItem[], index: number): ListHeading | null {
  for (let i = Math.min(index, items.length - 1); i >= 0; i--) {
    const item = items[i];
    if (isListHeading(item)) return item;
  }
  return null;
}

/** A heading's classes: its status's hue, and folded or open. */
export function listHeadingClassName(heading: Pick<ListHeading, "status" | "folded" | "count">): string {
  return [
    "tasks__group",
    `tasks__group--${heading.status}`,
    heading.folded && "tasks__group--folded",
    heading.count === 0 && "tasks__group--empty",
  ]
    .filter(Boolean)
    .join(" ");
}

function listRow(
  line: TaskRowView,
  status: TaskStatus,
  open: boolean,
  edge: GroupEdge,
  depth: 0 | 1,
  fold: ListRow["fold"],
): ListRow {
  return {
    kind: "row",
    key: line.id,
    status,
    line,
    open,
    edge,
    depth,
    fold,
    // Its status's tone, cancelled, and the open one.
    className: [
      "tasks__row",
      `tasks__row--${line.tone}`,
      line.cancelled && "tasks__row--cancelled",
      open && "tasks__row--open",
      depth === 1 && "tasks__row--under-epic",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** The row J (down) or K (up) moves to from the open one, and no further
 * than the ends. With no open row in the list (none open, or it is
 * folded or filtered away), J starts at the first row and K at the last.
 * Headings are passed over: a key moves between tasks. */
export function stepRow(items: readonly ListItem[], openId: string | null, step: 1 | -1): string | null {
  const rows = items.filter((item): item is ListRow => item.kind === "row");
  if (rows.length === 0) return null;
  const at = rows.findIndex((row) => row.key === openId);
  if (at < 0) return (step === 1 ? rows[0] : rows[rows.length - 1]).key;
  return rows[Math.min(Math.max(at + step, 0), rows.length - 1)].key;
}

/** The keys that walk the list, and which way — a bare J or K only, and
 * never while a field has the keys (a comment, a label being typed): a
 * chord is a shortcut's, a letter in a field is text. */
export function rowStepOf(key: { key: string; chord: boolean; inField: boolean }): 1 | -1 | null {
  if (key.chord || key.inField) return null;
  return key.key === "j" ? 1 : key.key === "k" ? -1 : null;
}

/** A group's part in a drag in flight — the drag's own rule, asked of the
 * group: the one under the pointer, framed whole (each item draws its own
 * edges of the frame, `GroupEdge`, as the windowed list draws each item
 * on its own), or dimmed where the task may not go. A group it may go to
 * but is not over wears nothing: only the landing place stands out. The
 * heading and the group's rows wear it alike, so a drop anywhere in a
 * group lands in it. */
export function groupDropClassName(item: Pick<ListItem, "status" | "edge">, drag: DragState, hover: TaskStatus | null): string | null {
  const drop = dropStateOf(item.status, drag, hover);
  if (drop === "over") return `tasks__drop--over tasks__drop-edge--${item.edge}`;
  return drop === "no" ? "tasks__drop--no" : null;
}

/** A row's classes as a drag sees it: its own, its group's part in the
 * drag, and dimmed while it is the one in flight. */
export function listRowClassName(row: ListRow, drag: DragState, hover: TaskStatus | null): string {
  return [
    row.className,
    groupDropClassName(row, drag, hover),
    drag.kind === "dragging" && drag.id === row.key && "tasks__row--dragging",
  ]
    .filter(Boolean)
    .join(" ");
}

/** A heading's classes as a drag sees it. */
export function listHeadingDropClassName(heading: ListHeading, drag: DragState, hover: TaskStatus | null): string {
  return [listHeadingClassName(heading), groupDropClassName(heading, drag, hover)].filter(Boolean).join(" ");
}

/** Where a dragged row is held: the row whole, at the point pressed — the
 * ghost is the row itself, its width the list's. */
export function rowGrip(row: { left: number; top: number; width: number }, x: number, y: number): RowGrip {
  return { width: row.width, offsetX: x - row.left, offsetY: y - row.top };
}
