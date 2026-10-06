import { describe, expect, it } from "vitest";
import { board, relation, task } from "../../domain/tasks/testSupport";
import { epicMark, statusRing, taskRowView } from "./taskRowView";

const NOW = 100_000;

describe("taskRowView", () => {
  it("says the priority, the assignee or the pool, the age, and every blocker as a chip", () => {
    const b = board([
      task({ id: "task-1", status: "in-progress", assignee: "impl-1" }),
      task({ id: "task-2", status: "done" }),
      task({ id: "task-3", blockedBy: ["task-1", "task-2"], priority: "high", updated: NOW - 120_000 }),
    ]);
    expect(taskRowView(b.tasks[2], b, NOW)).toMatchObject({
      id: "task-3",
      title: "Task task-3",
      priority: "HIGH",
      tone: "none",
      cancelled: false,
      labels: [],
      assignee: "unassigned",
      age: "2m ago",
      ring: { fill: 0, tone: "none", barred: false, label: "To do" },
    });
    // Every blocker as a chip, a resolved one struck.
    expect(taskRowView(b.tasks[2], b, NOW).blockerChips.map((c) => [c.id, c.resolved])).toEqual([
      ["task-1", false],
      ["task-2", true],
    ]);
    expect(taskRowView(b.tasks[0], b, NOW).blockerChips).toEqual([]);
    expect(taskRowView({ ...b.tasks[0], labels: ["ui"] }, b, NOW).labels).toEqual(["ui"]);
  });
});

describe("epicMark — what says a row is an epic", () => {
  it("counts done of the work it counts — cancelled work aside — as a count, a bar and words", () => {
    expect(epicMark({ done: 2, open: 3, cancelled: 4 })).toEqual({ chip: "EPIC", count: "2/5", fill: 40, label: "2 of 5 tasks done", summary: "2 of 5 done" });
    expect(epicMark({ done: 0, open: 0, cancelled: 1 })).toMatchObject({ count: "0/0", fill: 0 });
  });

  it("is a row's for an epic only", () => {
    const b = board([task({ id: "task-1", kind: "epic" }), task({ id: "task-2", status: "done" })], 3, [relation("child-of", "task-2", "task-1")]);
    expect(taskRowView(b.tasks[0], b, NOW).epic).toMatchObject({ count: "1/1", fill: 100 });
    expect(taskRowView(b.tasks[1], b, NOW).epic).toBeNull();
  });
});

describe("statusRing — a task's place on the ladder as a ring", () => {
  it("fills by the rung, in the status's hue; blocked is barred, cancelled a grey disc", () => {
    expect(statusRing("todo")).toEqual({ fill: 0, tone: "none", barred: false, dashed: false, label: "To do" });
    // Parked: not yet on the ladder — an empty ring, dashed.
    expect(statusRing("backlog")).toEqual({ fill: 0, tone: "none", barred: false, dashed: true, label: "Backlog" });
    expect(statusRing("in-progress")).toMatchObject({ fill: 50, tone: "working", barred: false });
    expect(statusRing("review")).toMatchObject({ fill: 75, tone: "waiting" });
    expect(statusRing("done")).toMatchObject({ fill: 100, tone: "done" });
    expect(statusRing("blocked")).toMatchObject({ fill: 0, tone: "failed", barred: true });
    expect(statusRing("cancelled")).toMatchObject({ fill: 100, tone: "none", barred: false });
  });
});
