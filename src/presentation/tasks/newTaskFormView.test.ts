import { describe, expect, it } from "vitest";
import { board, task } from "../../domain/tasks/testSupport";
import { newTaskFormView } from "./newTaskFormView";

const ROSTER = ["lead", "impl-1", "impl-2"];

describe("newTaskFormView — the kind and the epic", () => {
  it("offers work or an epic, and the team's open epics — none first — opening in the epic it was asked in", () => {
    const b = board([task({ id: "task-1", kind: "epic", title: "Plan" }), task({ id: "task-2", kind: "epic", status: "done" }), task({ id: "task-3", kind: "epic", teamId: "team-2" })], 4);
    const view = newTaskFormView(ROSTER, b, "team-1", "task-1");
    expect(view.kindOptions).toEqual([{ value: "task", label: "Task" }, { value: "epic", label: "Epic" }]);
    expect(view.epicOptions).toEqual([{ value: "", label: "No epic" }, { value: "task-1", label: "task-1 · Plan" }]);
    expect(view.draft.parent).toBe("task-1");
    expect(newTaskFormView(ROSTER, null, null, null).epicOptions).toEqual([{ value: "", label: "No epic" }]);
    // Without a board, or without a team, there is no epic to offer.
    expect(newTaskFormView(ROSTER, b, null, null).epicOptions).toEqual([{ value: "", label: "No epic" }]);
    expect(newTaskFormView(ROSTER, null, "team-1", null).epicOptions).toEqual([{ value: "", label: "No epic" }]);
    // Opened in an epic new work cannot go under: it starts under none.
    expect(newTaskFormView(ROSTER, b, "team-1", "task-2").draft.parent).toBe("");
    expect(newTaskFormView(ROSTER, b, "team-1", "task-9").draft.parent).toBe("");
  });
});

describe("newTaskFormView", () => {
  it("offers the pool first, then the roster, and says which addresses teammates use", () => {
    const view = newTaskFormView(ROSTER, null, null, null);
    expect(view.assigneeOptions.map((o) => o.value)).toEqual(["", "lead", "impl-1", "impl-2"]);
    expect(view.addressHint).toContain("lead · impl-1 · impl-2");
    expect(newTaskFormView([], null, null, null).addressHint).toContain("unassigned");
    expect(newTaskFormView([], null, null, null).statusOptions).toEqual([
      { value: "todo", label: "To do" },
      { value: "backlog", label: "Backlog" },
    ]);
  });
});
