import { describe, expect, it } from "vitest";
import { board, relation, task } from "../../domain/tasks/testSupport";
import {
  LIST_HEAD_ESTIMATE_PX,
  LIST_ROW_ESTIMATE_PX,
  headingOf,
  isListHeading,
  listHeadingClassName,
  listItemEstimate,
  listItemKey,
  listView,
  rowInFlight,
  groupDropClassName,
  listHeadingDropClassName,
  listRowClassName,
  rowStepOf,
  stepRow,
  type GroupEdge,
  type ListItem,
} from "./listView";
import { NO_QUERY } from "./queryView";
import { taskRowView } from "./taskRowView";
import { IDLE, armRow, moveRow, rowGrip, type DragState } from "./rowDrag";
import { BOARD_ORDER, EPIC_FOLD_WORDS } from "./words";
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
    // The seven groups, top to bottom, in the board order.
    const heads = listView(tasks, b, 0, NO_QUERY, NONE, null).filter((i) => i.kind === "head");
    expect(heads.map((h) => h.kind === "head" && h.status)).toEqual([...BOARD_ORDER]);
  });

  it("heads every status even when the query leaves it empty, counting what it shows", () => {
    const items = listView(tasks, b, 0, { label: "ui" }, NONE, null);
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
    const key = (k: string, over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; inField: boolean }> = {}) =>
      rowStepOf({ key: k, metaKey: false, ctrlKey: false, altKey: false, inField: false, ...over });
    expect(key("j")).toBe(1);
    expect(key("k")).toBe(-1);
    expect(key("J")).toBeNull();
    // A chord — with any of ⌘, Ctrl, Alt — is a shortcut's; a letter in a field is text.
    expect(key("j", { metaKey: true })).toBeNull();
    expect(key("j", { ctrlKey: true })).toBeNull();
    expect(key("j", { altKey: true })).toBeNull();
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
    const items = listView(labelled, board(labelled), 0, { label: "ui" }, NONE, null);
    const edgeOf = (key: string) => items.find((i) => i.key === key)!.edge;
    const todoRows = items.filter((i) => i.kind === "row" && i.status === "todo");
    // Two shown of three: the second shown closes it, not the hidden third.
    expect(todoRows.map((r) => r.edge)).toEqual(["middle", "bottom"]);
    expect(edgeOf("head:todo")).toBe("top");
    // Done has a task, but none the query shows: its heading alone.
    expect(edgeOf("head:done")).toBe("whole");
    // One shown: it alone closes the frame.
    const one = listView(labelled.slice(1), board(labelled.slice(1)), 0, { label: "ui" }, NONE, null);
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

describe("listView — an epic with its tasks under it (B1)", () => {
  const family = [
    task({ id: "task-1", kind: "epic", status: "in-progress" }),
    task({ id: "task-2", status: "done", updated: 10 }),
    task({ id: "task-3", status: "todo", priority: "low", created: 3, labels: ["ui"] }),
    task({ id: "task-4", status: "review" }),
    task({ id: "task-5", status: "todo", priority: "high", created: 5 }),
    task({ id: "task-6", status: "todo" }),
  ];
  const fb = board(family, 7, ["task-2", "task-3", "task-4", "task-5"].map((id) => relation("child-of", id, "task-1")));
  const OPEN = new Set<TaskStatus>();

  it("stands the epic in its own group, every task under it one step in, by group then queue order — and none in its own group", () => {
    const items = listView(family, fb, 0, NO_QUERY, OPEN, null);
    expect(keys(items)).toEqual([
      "head:blocked",
      "head:backlog",
      "head:todo",
      "task-6",
      "head:in-progress",
      "task-1",
      "task-5",
      "task-3",
      "task-4",
      "task-2",
      "head:review",
      "head:done",
      "head:cancelled",
    ]);
    const row = (key: string) => items.find((i) => i.key === key) as Extract<ListItem, { kind: "row" }>;
    // The gutter is the row's own: the epic's fold, its tasks' guide — stopping at the last — nothing for the rest.
    expect(["task-1", "task-5", "task-4", "task-2", "task-6"].map((k) => row(k).lead)).toEqual(["fold", "guide", "guide", "guide-end", "none"]);
    expect(["task-1", "task-4", "task-2", "task-6"].map((k) => row(k).leadClassName)).toEqual([
      "tasks__row-lead",
      "tasks__row-lead tasks__row-lead--guide",
      "tasks__row-lead tasks__row-lead--guide tasks__row-lead--end",
      "tasks__row-lead",
    ]);
    // Every row of the group sits in it for a drop: the epic's status.
    expect(row("task-4").status).toBe("in-progress");
    expect(row("task-4").className).toContain("tasks__row--under-epic");
    expect(row("task-2").className).toContain("tasks__row--under-epic");
    expect(row("task-1").className).not.toContain("tasks__row--under-epic");
    // Its fold is kept by its uid: a task's id is per workspace, the folds are the app's.
    expect(row("task-1").fold).toEqual({ folded: false, label: EPIC_FOLD_WORDS.fold, uid: "uid-task-1" });
    expect(row("task-4").fold).toBeNull();
    expect(row("task-2").edge).toBe("bottom");
    // A heading counts every row it holds: the epic and its four.
    expect(items.find((i) => i.key === "head:in-progress")).toMatchObject({ count: 5 });
    expect(items.find((i) => i.key === "head:review")).toMatchObject({ count: 0 });
  });

  it("folds an epic to its row — the heading still counting its tasks — and J / K walk what is shown", () => {
    const items = listView(family, fb, 0, NO_QUERY, OPEN, null, new Set(["uid-task-1"]));
    expect(keys(items).slice(4, 7)).toEqual(["head:in-progress", "task-1", "head:review"]);
    expect(items.find((i) => i.key === "task-1")).toMatchObject({ fold: { folded: true, label: EPIC_FOLD_WORDS.unfold } });
    // An id is no uid: a fold kept by "task-1" folds nothing.
    expect(keys(listView(family, fb, 0, NO_QUERY, OPEN, null, new Set(["task-1"])))).toContain("task-5");
    expect(items.find((i) => i.key === "head:in-progress")).toMatchObject({ count: 5 });
    expect(stepRow(listView(family, fb, 0, NO_QUERY, OPEN, null), "task-1", 1)).toBe("task-5");
  });

  it("keeps a task the query lets through under its epic, the epic shown over it whether or not it matches", () => {
    const items = listView(family, fb, 0, { label: "ui" }, OPEN, null);
    expect(keys(items).filter((k) => !k.startsWith("head:"))).toEqual(["task-1", "task-3"]);
    expect(items.find((i) => i.key === "head:in-progress")).toMatchObject({ count: 2 });
    // An epic that matches with none of its tasks: shown alone.
    const labelledEpic = family.map((t) => (t.id === "task-1" ? { ...t, labels: ["plan"] } : t));
    const alone = listView(labelledEpic, board(labelledEpic, 7, fb.relations), 0, { label: "plan" }, OPEN, null);
    expect(keys(alone).filter((k) => !k.startsWith("head:"))).toEqual(["task-1"]);
  });

  it("dresses a cancelled row as cancelled, and no other", () => {
    const rows = listView(family, fb, 0, NO_QUERY, OPEN, null).filter((i): i is Extract<ListItem, { kind: "row" }> => i.kind === "row");
    expect(rows.filter((r) => r.className.includes("tasks__row--cancelled")).map((r) => r.key)).toEqual([]);
    const withCancelled = [...family, task({ id: "task-7", status: "cancelled" })];
    const all = listView(withCancelled, board(withCancelled, 8, fb.relations), 0, NO_QUERY, OPEN, null);
    expect(all.filter((i) => i.kind === "row" && i.className.includes("tasks__row--cancelled")).map((i) => i.key)).toEqual(["task-7"]);
  });

  it("draws the row in flight with a row's gutter, so its columns stand where the row's did: an epic's fold, any other empty", () => {
    const flying = (id: string, folded: ReadonlySet<string> = new Set()) =>
      rowInFlight(moveRow(armRow(id, 0, 0, { width: 200, offsetX: 0, offsetY: 0 }), 50, 50, () => new Set()), fb, "team-1", 0, folded);
    expect(flying("task-1")).toEqual({
      line: taskRowView(family[0], fb, 0),
      fold: { folded: false, label: EPIC_FOLD_WORDS.fold, uid: "uid-task-1" },
      lead: "fold",
      leadClassName: "tasks__row-lead",
    });
    expect(flying("task-1", new Set(["uid-task-1"]))?.fold).toMatchObject({ folded: true, label: EPIC_FOLD_WORDS.unfold });
    // A task under an epic: the gutter, empty — a guide in flight would join nothing.
    expect(flying("task-4")).toMatchObject({ fold: null, lead: "none", leadClassName: "tasks__row-lead" });
    // Nothing in flight, or a task on no board on screen: no row.
    expect(rowInFlight(armRow("task-1", 0, 0, { width: 200, offsetX: 0, offsetY: 0 }), fb, "team-1", 0)).toBeNull();
    expect(flying("task-99")).toBeNull();
  });

  it("puts a task whose epic is not shown here at the top of its own group", () => {
    const loose = family.filter((t) => t.id !== "task-1");
    expect(keys(listView(loose, fb, 0, NO_QUERY, OPEN, null)).slice(0, 6)).toEqual(["head:blocked", "head:backlog", "head:todo", "task-5", "task-6", "task-3"]);
  });
});
