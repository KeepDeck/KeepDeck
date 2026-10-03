import { describe, expect, it } from "vitest";
import { task } from "../../domain/tasks/testSupport";
import {
  ANY_LABEL,
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
    expect(queryToolbarView(NO_QUERY, []).blocked).toEqual({ label: QUERY_WORDS.blocked, pressed: false });
    expect(queryToolbarView({ blockedOnly: true, label: null }, []).blocked.pressed).toBe(true);
  });

  it("offers every label the board carries after 'all', and hides the picker while there are none", () => {
    expect(queryToolbarView(NO_QUERY, []).label).toBeNull();
    const view = queryToolbarView(NO_QUERY, ["ui", "bell"]).label!;
    expect(view.value).toBe(ANY_LABEL);
    expect(view.options.map((o) => o.label)).toEqual([QUERY_WORDS.anyLabel, "ui", "bell"]);
  });

  it("keeps a picked label no task carries any more, so the control still says what narrows the view", () => {
    const view = queryToolbarView({ blockedOnly: false, label: "gone" }, [])!.label!;
    expect(view.value).toBe("gone");
    expect(view.options.map((o) => o.value)).toEqual([ANY_LABEL, "gone"]);
  });

  it("reads a pick back into the query — 'all' clears it", () => {
    expect(withLabel(NO_QUERY, "ui")).toEqual({ blockedOnly: false, label: "ui" });
    expect(withLabel({ blockedOnly: true, label: "ui" }, ANY_LABEL)).toEqual({ blockedOnly: true, label: null });
  });
});
