import { describe, expect, it } from "vitest";
import { task } from "../../domain/tasks/testSupport";
import {
  NO_QUERY,
  QUERY_WORDS,
  compareInStatus,
  matchesQuery,
  queryToolbarView,
  tasksInStatus,
  withLabel,
} from "./queryView";

describe("the tracker's one set and one order", () => {
  it("narrows to blocked work, to one label, or both — nothing by default", () => {
    const blockedUi = task({ id: "task-1", status: "blocked", labels: ["ui"] });
    const openUi = task({ id: "task-2", labels: ["ui"] });
    const blockedBare = task({ id: "task-3", status: "blocked" });
    const all = [blockedUi, openUi, blockedBare];
    const shown = (q: typeof NO_QUERY) => all.filter((t) => matchesQuery(t, q)).map((t) => t.id);
    expect(shown(NO_QUERY)).toEqual(["task-1", "task-2", "task-3"]);
    expect(shown({ blockedOnly: true, label: null })).toEqual(["task-1", "task-3"]);
    expect(shown({ blockedOnly: false, label: "ui" })).toEqual(["task-1", "task-2"]);
    expect(shown({ blockedOnly: true, label: "ui" })).toEqual(["task-1"]);
  });

  it("orders open work as the queue (priority, then oldest) and closed work newest first", () => {
    const tasks = [
      task({ id: "task-1", priority: "normal", created: 1 }),
      task({ id: "task-2", priority: "high", created: 5 }),
      task({ id: "task-3", status: "done", updated: 10 }),
      task({ id: "task-4", status: "done", updated: 30 }),
    ];
    expect(tasksInStatus(tasks, "todo", NO_QUERY).map((t) => t.id)).toEqual(["task-2", "task-1"]);
    expect(tasksInStatus(tasks, "done", NO_QUERY).map((t) => t.id)).toEqual(["task-4", "task-3"]);
    expect([...tasks].filter((t) => t.status === "done").sort(compareInStatus("done"))[0].id).toBe("task-4");
  });

  it("applies the query within a status", () => {
    const tasks = [task({ id: "task-1", labels: ["ui"] }), task({ id: "task-2" })];
    expect(tasksInStatus(tasks, "todo", { blockedOnly: false, label: "ui" }).map((t) => t.id)).toEqual(["task-1"]);
  });
});

describe("queryToolbarView — the filters as the toolbar draws them", () => {
  it("says whether Blocked is on", () => {
    expect(queryToolbarView(NO_QUERY).blocked).toEqual({ label: QUERY_WORDS.blocked, pressed: false });
    expect(queryToolbarView({ blockedOnly: true, label: null }).blocked.pressed).toBe(true);
  });

  it("shows the narrowing label as a chip that clears it — nothing while none narrows", () => {
    expect(queryToolbarView(NO_QUERY).label).toBeNull();
    expect(queryToolbarView({ blockedOnly: false, label: "ui" }).label).toEqual({
      text: "label: ui",
      clear: "Show every label, not only ui",
    });
  });

  it("narrows to a clicked label, and widens again on the same one or a clear", () => {
    expect(withLabel(NO_QUERY, "ui")).toEqual({ blockedOnly: false, label: "ui" });
    expect(withLabel({ blockedOnly: true, label: "ui" }, "ui")).toEqual({ blockedOnly: true, label: null });
    expect(withLabel({ blockedOnly: false, label: "ui" }, "bell")).toEqual({ blockedOnly: false, label: "bell" });
    expect(withLabel({ blockedOnly: false, label: "ui" }, null)).toEqual({ blockedOnly: false, label: null });
  });
});
