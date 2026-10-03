import { describe, expect, it } from "vitest";
import { board, task } from "../../domain/tasks/testSupport";
import {
  FOLDED_AT_OPEN,
  LIST_HEAD_ESTIMATE_PX,
  LIST_ROW_ESTIMATE_PX,
  headingOf,
  listHeadingClassName,
  listItemEstimate,
  listItemKey,
  listView,
  rowStepOf,
  stepRow,
  toggleFold,
  type ListItem,
} from "./listView";
import { NO_QUERY } from "./queryView";
import { BOARD_ORDER } from "./words";

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
    // The same six groups, left to right, as the board's columns.
    const heads = listView(tasks, b, 0, NO_QUERY, NONE, null).filter((i) => i.kind === "head");
    expect(heads.map((h) => h.kind === "head" && h.status)).toEqual([...BOARD_ORDER]);
  });

  it("heads every status even when the query leaves it empty, counting what it shows", () => {
    const items = listView(tasks, b, 0, { blockedOnly: false, label: "ui" }, NONE, null);
    expect(keys(items)).toEqual(["head:blocked", "head:todo", "head:in-progress", "head:review", "task-5", "head:done", "head:cancelled"]);
    expect(items[3]).toMatchObject({ kind: "head", label: "Review", count: 1, folded: false });
    expect(items[0]).toMatchObject({ kind: "head", count: 0 });
    expect(listHeadingClassName(items[0] as never)).toContain("tasks__group--empty");
  });

  it("folds a group to its heading alone — the heading stays, with the count of what it hides", () => {
    const items = listView(tasks, b, 0, NO_QUERY, new Set(["todo"]), null);
    expect(keys(items)).toEqual([
      "head:blocked",
      "task-3",
      "head:todo",
      "head:in-progress",
      "head:review",
      "task-5",
      "head:done",
      "task-4",
      "head:cancelled",
    ]);
    expect(items[2]).toMatchObject({ kind: "head", count: 2, folded: true });
  });

  it("opens with the closed work folded", () => {
    expect([...FOLDED_AT_OPEN].sort()).toEqual(["cancelled", "done"]);
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
    expect(headingOf(items, 4)?.status).toBe("todo");
    expect(headingOf(items, 5)?.status).toBe("in-progress");
    expect(headingOf(items, 99)?.status).toBe("cancelled");
    expect(headingOf([], 0)).toBeNull();
  });

  it("toggles a fold without touching the others", () => {
    const once = toggleFold(new Set(["done"]), "todo");
    expect([...once].sort()).toEqual(["done", "todo"]);
    expect([...toggleFold(once, "done")]).toEqual(["todo"]);
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
  });

  it("reads j as down, k as up, anything else as no step", () => {
    expect(rowStepOf("j")).toBe(1);
    expect(rowStepOf("k")).toBe(-1);
    expect(rowStepOf("J")).toBeNull();
  });
});
