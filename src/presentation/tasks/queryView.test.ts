import { describe, expect, it } from "vitest";
import { task } from "../../domain/tasks/testSupport";
import {
  NO_QUERY,
  compareInStatus,
  findsNothing,
  matchesQuery,
  queryToolbarView,
  withLabel,
} from "./queryView";

describe("the tracker's one set and one order", () => {
  it("narrows to one label — nothing by default", () => {
    const blockedUi = task({ id: "task-1", status: "blocked", labels: ["ui"] });
    const openUi = task({ id: "task-2", labels: ["ui"] });
    const blockedBare = task({ id: "task-3", status: "blocked" });
    const all = [blockedUi, openUi, blockedBare];
    const shown = (q: typeof NO_QUERY) => all.filter((t) => matchesQuery(t, q)).map((t) => t.id);
    expect(shown(NO_QUERY)).toEqual(["task-1", "task-2", "task-3"]);
    expect(shown({ label: "ui" })).toEqual(["task-1", "task-2"]);
  });

  it("orders open work as the queue (priority, then oldest) and closed work newest first", () => {
    const tasks = [
      task({ id: "task-1", priority: "normal", created: 1 }),
      task({ id: "task-2", priority: "high", created: 5 }),
      task({ id: "task-3", status: "done", updated: 10 }),
      task({ id: "task-4", status: "done", updated: 30 }),
    ];
    const inOrder = (status: "todo" | "done") => tasks.filter((t) => t.status === status).sort(compareInStatus(status)).map((t) => t.id);
    expect(inOrder("todo")).toEqual(["task-2", "task-1"]);
    expect(inOrder("done")).toEqual(["task-4", "task-3"]);
    expect([...tasks].filter((t) => t.status === "done").sort(compareInStatus("done"))[0].id).toBe("task-4");
  });

});

describe("queryToolbarView — the filters as the toolbar draws them", () => {
  it("shows the narrowing label as a chip that clears it — nothing while none narrows", () => {
    expect(queryToolbarView(NO_QUERY).label).toBeNull();
    expect(queryToolbarView({ label: "ui" }).label).toEqual({
      text: "label: ui",
      clear: "Show every label, not only ui",
    });
  });

  it("narrows to a clicked label, and widens again on the same one or a clear", () => {
    expect(withLabel(NO_QUERY, "ui")).toEqual({ label: "ui" });
    expect(withLabel({ label: "ui" }, "ui")).toEqual({ label: null });
    expect(withLabel({ label: "ui" }, "bell")).toEqual({ label: "bell" });
    expect(withLabel({ label: "ui" }, null)).toEqual({ label: null });
  });

  it("finds nothing only when something narrows and no task gets through", () => {
    const tasks = [task({ id: "task-1", labels: ["ui"] })];
    expect(findsNothing(tasks, NO_QUERY)).toBe(false);
    expect(findsNothing([], NO_QUERY)).toBe(false);
    expect(findsNothing(tasks, { label: "ui" })).toBe(false);
    expect(findsNothing(tasks, { label: "bell" })).toBe(true);
  });
});
