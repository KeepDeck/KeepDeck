import { describe, expect, it } from "vitest";
import { board, task } from "../../domain/tasks/testSupport";
import {
  LIST_HEAD_ESTIMATE_PX,
  LIST_ROW_ESTIMATE_PX,
  headingOf,
  isListHeading,
  listHeadingClassName,
  listItemEstimate,
  listItemKey,
  listView,
  groupDropClassName,
  listHeadingDropClassName,
  listRowClassName,
  rowGrip,
  rowStepOf,
  stepRow,
  type GroupEdge,
  type ListItem,
} from "./listView";
import { NO_QUERY } from "./queryView";
import { IDLE, type DragState } from "./cardDrag";
import { BOARD_ORDER } from "./words";
import type { TaskStatus } from "../../domain/tasks";

const tasks = [
  task({ id: "task-1", status: "todo", priority: "normal", created: 1 }),
  task({ id: "task-2", status: "todo", priority: "high", created: 2 }),
  task({ id: "task-3", status: "blocked" }),
  task({ id: "task-4", status: "done", updated: 50 }),
  task({ id: "task-5", status: "review", labels: ["ui"] }),
];
const b = board(tasks);
const keys = (items: ListItem[]) => items.map(listItemKey);
const NONE = new Set<never>();

describe("listView — the board's tasks as one list", () => {
  it("heads each status in the board's column order, rows in the tracker's one order", () => {
    expect(keys(listView(tasks, b, 0, NO_QUERY, NONE, null))).toEqual([
      "head:blocked",
      "task-3",
      "head:backlog",
      "head:todo",
      "task-2",
      "task-1",
      "head:in-progress",
      "head:review",
      "task-5",
      "head:done",
      "task-4",
      "head:cancelled",
    ]);
    // The same seven groups, left to right, as the board's columns.
    const heads = listView(tasks, b, 0, NO_QUERY, NONE, null).filter((i) => i.kind === "head");
    expect(heads.map((h) => h.kind === "head" && h.status)).toEqual([...BOARD_ORDER]);
  });

  it("heads every status even when the query leaves it empty, counting what it shows", () => {
    const items = listView(tasks, b, 0, { blockedOnly: false, label: "ui" }, NONE, null);
    expect(keys(items)).toEqual(["head:blocked", "head:backlog", "head:todo", "head:in-progress", "head:review", "task-5", "head:done", "head:cancelled"]);
    expect(items[4]).toMatchObject({ kind: "head", label: "Review", count: 1, folded: false });
    expect(items[0]).toMatchObject({ kind: "head", count: 0 });
    expect(listHeadingClassName(items[0] as never)).toContain("tasks__group--empty");
  });

  it("folds a group to its heading alone — the heading stays, with the count of what it hides", () => {
    const items = listView(tasks, b, 0, NO_QUERY, new Set(["todo"]), null);
    expect(keys(items)).toEqual([
      "head:blocked",
      "task-3",
      "head:backlog",
      "head:todo",
      "head:in-progress",
      "head:review",
      "task-5",
      "head:done",
      "task-4",
      "head:cancelled",
    ]);
    expect(items[3]).toMatchObject({ kind: "head", count: 2, folded: true });
  });

  it("marks the row of the open task, and only it", () => {
    const rows = listView(tasks, b, 0, NO_QUERY, NONE, "task-2").filter((i) => i.kind === "row");
    expect(rows.map((r) => r.kind === "row" && [r.key, r.open, r.className.includes("tasks__row--open")])).toContainEqual([
      "task-2",
      true,
      true,
    ]);
    expect(rows.filter((r) => r.kind === "row" && r.open)).toHaveLength(1);
  });

  it("guesses a heading's and a row's height apart", () => {
    const [head, row] = listView(tasks, b, 0, NO_QUERY, NONE, null);
    expect(listItemEstimate(head)).toBe(LIST_HEAD_ESTIMATE_PX);
    expect(listItemEstimate(row)).toBe(LIST_ROW_ESTIMATE_PX);
  });

  it("names the group any index is in — a heading heads itself; nothing before the first", () => {
    const items = listView(tasks, b, 0, NO_QUERY, NONE, null);
    expect(headingOf(items, 0)?.status).toBe("blocked");
    expect(headingOf(items, 2)?.status).toBe("backlog");
    expect(headingOf(items, 5)?.status).toBe("todo");
    expect(headingOf(items, 6)?.status).toBe("in-progress");
    expect(headingOf(items, 99)?.status).toBe("cancelled");
    expect(headingOf([], 0)).toBeNull();
    // A group starts at its heading, never at one of its rows.
    expect(isListHeading(items[0])).toBe(true);
    expect(isListHeading(items[1])).toBe(false);
    expect(isListHeading(items[2])).toBe(true);
  });

  it("dresses a heading in its status, folded or open", () => {
    expect(listHeadingClassName({ status: "review", folded: true, count: 2 })).toBe("tasks__group tasks__group--review tasks__group--folded");
    expect(listHeadingClassName({ status: "todo", folded: false, count: 1 })).toBe("tasks__group tasks__group--todo");
    expect(listHeadingClassName({ status: "todo", folded: false, count: 0 })).toBe("tasks__group tasks__group--todo tasks__group--empty");
  });
});

describe("stepRow — J and K walk the tasks", () => {
  const items = listView(tasks, b, 0, NO_QUERY, new Set(), null);
  it("starts at the first row, moves over headings, and stops at the ends", () => {
    expect(stepRow(items, null, 1)).toBe("task-3");
    expect(stepRow(items, "task-3", 1)).toBe("task-2");
    expect(stepRow(items, "task-1", 1)).toBe("task-5");
    expect(stepRow(items, "task-3", -1)).toBe("task-3");
    expect(stepRow(items, "task-4", 1)).toBe("task-4");
    expect(stepRow([], null, 1)).toBeNull();
    // No open row in the list: J starts at the top, K at the bottom.
    expect(stepRow(items, null, -1)).toBe("task-4");
    expect(stepRow(items, "task-9", -1)).toBe("task-4");
  });

  it("reads j as down, k as up, anything else as no step", () => {
    const key = (k: string, over: Partial<{ chord: boolean; inField: boolean }> = {}) =>
      rowStepOf({ key: k, chord: false, inField: false, ...over });
    expect(key("j")).toBe(1);
    expect(key("k")).toBe(-1);
    expect(key("J")).toBeNull();
    // A chord is a shortcut's; a letter in a field is text.
    expect(key("j", { chord: true })).toBeNull();
    expect(key("k", { inField: true })).toBeNull();
  });
});

describe("the list in a drag", () => {
  const items = listView(tasks, b, 0, NO_QUERY, NONE, null);
  const rowOf = (id: string) => items.find((i) => i.key === id) as Extract<ListItem, { kind: "row" }>;
  const dragging: DragState = { kind: "dragging", id: "task-1", x: 0, y: 0, grip: { width: 1, offsetX: 0, offsetY: 0 }, targets: new Set(["in-progress", "done"]) };

  it("knows each row's group — where a drop on it lands", () => {
    expect(rowOf("task-3").status).toBe("blocked");
    expect(rowOf("task-4").status).toBe("done");
  });

  it("lights only where the task will land, and dims where it may not go", () => {
    const at = (status: TaskStatus, edge: GroupEdge = "middle") => ({ status, edge });
    // A target the pointer is not over wears nothing.
    expect(groupDropClassName(at("done"), dragging, null)).toBeNull();
    expect(groupDropClassName(at("done"), dragging, "done")).toBe("tasks__drop--over tasks__drop-edge--middle");
    // Each item hands on its own edge of the frame.
    for (const edge of ["whole", "top", "bottom"] as const) {
      expect(groupDropClassName(at("done", edge), dragging, "done")).toBe(`tasks__drop--over tasks__drop-edge--${edge}`);
    }
    expect(groupDropClassName(at("review"), dragging, null)).toBe("tasks__drop--no");
    expect(groupDropClassName(at("done"), IDLE, null)).toBeNull();
  });

  it("frames the group under the pointer whole: its heading opens the frame, its last row closes it", () => {
    const todo = listView(tasks, b, 0, NO_QUERY, NONE, null);
    const edgeOf = (key: string) => todo.find((i) => i.key === key)!.edge;
    expect([edgeOf("head:todo"), edgeOf("task-2"), edgeOf("task-1")]).toEqual(["top", "middle", "bottom"]);
    // One row: it alone closes the frame.
    expect([edgeOf("head:done"), edgeOf("task-4")]).toEqual(["top", "bottom"]);
    // No rows shown — empty, or folded: the heading is the whole frame.
    expect(edgeOf("head:in-progress")).toBe("whole");
    expect(listView(tasks, b, 0, NO_QUERY, new Set(["todo"] as const), null).find((i) => i.key === "head:todo")!.edge).toBe("whole");
  });

  it("frames what the query leaves shown: its last shown row closes the frame, none shown is the heading alone", () => {
    const labelled = [
      task({ id: "task-1", status: "todo", labels: ["ui"], created: 1 }),
      task({ id: "task-2", status: "todo", labels: ["ui"], created: 2 }),
      task({ id: "task-3", status: "todo", created: 3 }),
      task({ id: "task-4", status: "done" }),
    ];
    const items = listView(labelled, board(labelled), 0, { blockedOnly: false, label: "ui" }, NONE, null);
    const edgeOf = (key: string) => items.find((i) => i.key === key)!.edge;
    const todoRows = items.filter((i) => i.kind === "row" && i.status === "todo");
    // Two shown of three: the second shown closes it, not the hidden third.
    expect(todoRows.map((r) => r.edge)).toEqual(["middle", "bottom"]);
    expect(edgeOf("head:todo")).toBe("top");
    // Done has a task, but none the query shows: its heading alone.
    expect(edgeOf("head:done")).toBe("whole");
    // One shown: it alone closes the frame.
    const one = listView(labelled.slice(1), board(labelled.slice(1)), 0, { blockedOnly: false, label: "ui" }, NONE, null);
    expect(one.filter((i) => i.kind === "row").map((r) => r.edge)).toEqual(["bottom"]);
  });

  it("dims the row in flight and wears its group's part on every row and heading", () => {
    expect(listRowClassName(rowOf("task-1"), dragging, null)).toContain("tasks__row--dragging");
    expect(listRowClassName(rowOf("task-4"), dragging, "done")).toContain("tasks__drop--over");
    expect(listRowClassName(rowOf("task-4"), IDLE, null)).toBe(rowOf("task-4").className);
    const done = items.find((i) => i.key === "head:done") as Extract<ListItem, { kind: "head" }>;
    expect(listHeadingDropClassName(done, dragging, null)).toBe("tasks__group tasks__group--done");
    expect(listHeadingDropClassName(done, dragging, "done")).toBe("tasks__group tasks__group--done tasks__drop--over tasks__drop-edge--top");
  });

  it("holds the row whole, where it was pressed", () => {
    expect(rowGrip({ left: 100, top: 50, width: 900 }, 700, 60)).toEqual({ width: 900, offsetX: 600, offsetY: 10 });
  });

});
