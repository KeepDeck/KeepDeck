import { describe, expect, it } from "vitest";
import { EMPTY_TASK_DRAFT, assigneeOf, draftIn, pickedOrNone, takesAnEpic, taskInputOf } from "./formDraft";

describe("formDraft", () => {
  it("an empty form is the domain's defaults; an empty assignee pick is the pool", () => {
    expect(EMPTY_TASK_DRAFT.priority).toBe("normal");
    expect(assigneeOf("")).toBeNull();
    expect(assigneeOf("impl-1")).toBe("impl-1");
    expect([pickedOrNone(""), pickedOrNone("task-3")]).toEqual([null, "task-3"]);
    expect(taskInputOf({ ...EMPTY_TASK_DRAFT, title: "Draft", assignee: "" })).toEqual({
      title: "Draft",
      body: "",
      assignee: null,
      priority: "normal",
      status: "todo",
      kind: "task",
    });
    expect(taskInputOf({ ...EMPTY_TASK_DRAFT, title: "Draft", assignee: "impl-2", priority: "high" }).assignee).toBe("impl-2");
    // Parked from the form: it starts in the backlog.
    expect(taskInputOf({ ...EMPTY_TASK_DRAFT, title: "Idea", status: "backlog" }).status).toBe("backlog");
  });

  it("opens in the epic it was opened in, and hands an epic over under none", () => {
    expect(draftIn(null)).toBe(EMPTY_TASK_DRAFT);
    expect(draftIn("task-3")).toEqual({ ...EMPTY_TASK_DRAFT, parent: "task-3" });
    expect(taskInputOf({ ...draftIn("task-3"), title: "Step" })).toMatchObject({ kind: "task", parent: "task-3" });
    // An epic picked, then the kind turned to epic: it goes under none.
    expect(taskInputOf({ ...draftIn("task-3"), title: "Plan", kind: "epic" })).not.toHaveProperty("parent");
    expect(taskInputOf({ ...EMPTY_TASK_DRAFT, title: "Plan", kind: "epic" }).kind).toBe("epic");
    expect([takesAnEpic({ kind: "task" }), takesAnEpic({ kind: "epic" })]).toEqual([true, false]);
  });
});
