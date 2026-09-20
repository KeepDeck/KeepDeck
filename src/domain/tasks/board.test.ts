import { describe, expect, it } from "vitest";
import {
  attentionCount,
  compareQueue,
  countByStatus,
  issuable,
  mine,
  nextFor,
  openBlockersOf,
  poolOf,
  queueOf,
  unblocks,
} from "./board";
import { board, task } from "./testSupport";

describe("issuable", () => {
  it("is a todo task with every blocker resolved", () => {
    const b = board([task({ id: "task-1" })]);
    expect(issuable(b.tasks[0], b)).toBe(true);
  });

  it("is false for any status but todo", () => {
    for (const status of ["in-progress", "blocked", "review", "done", "cancelled"] as const) {
      const b = board([task({ id: "task-1", status })]);
      expect(issuable(b.tasks[0], b)).toBe(false);
    }
  });

  it("holds a todo task behind an open blocker, and releases it when the blocker is done OR cancelled", () => {
    for (const blockerStatus of ["todo", "in-progress", "blocked", "review"] as const) {
      const b = board([
        task({ id: "task-1", status: blockerStatus }),
        task({ id: "task-2", blockedBy: ["task-1"] }),
      ]);
      expect(issuable(b.tasks[1], b)).toBe(false);
      expect(openBlockersOf(b.tasks[1], b)).toEqual(["task-1"]);
    }
    for (const blockerStatus of ["done", "cancelled"] as const) {
      const b = board([
        task({ id: "task-1", status: blockerStatus }),
        task({ id: "task-2", blockedBy: ["task-1"] }),
      ]);
      expect(issuable(b.tasks[1], b)).toBe(true);
    }
  });

  it("treats a blocker the board does not hold as resolved — a phantom must not block forever", () => {
    const b = board([task({ id: "task-2", blockedBy: ["task-9"] })]);
    expect(issuable(b.tasks[0], b)).toBe(true);
  });
});

describe("unblocks", () => {
  it("is the reverse edge, derived from the dependants", () => {
    const b = board([
      task({ id: "task-1" }),
      task({ id: "task-2", blockedBy: ["task-1"] }),
      task({ id: "task-3", blockedBy: ["task-1", "task-2"] }),
    ]);
    expect(unblocks(b.tasks[0], b).map((t) => t.id)).toEqual(["task-2", "task-3"]);
    expect(unblocks(b.tasks[2], b)).toEqual([]);
  });
});

describe("compareQueue", () => {
  it("orders by priority, then the older task, then the id", () => {
    const sorted = [
      task({ id: "task-3", priority: "low", created: 1 }),
      task({ id: "task-2", priority: "normal", created: 5 }),
      task({ id: "task-1", priority: "normal", created: 5 }),
      task({ id: "task-4", priority: "high", created: 9 }),
      task({ id: "task-5", priority: "normal", created: 2 }),
    ].sort(compareQueue);
    expect(sorted.map((t) => t.id)).toEqual(["task-4", "task-5", "task-1", "task-2", "task-3"]);
  });
});

describe("queues", () => {
  const b = board([
    task({ id: "task-1", status: "in-progress", assignee: "impl-1" }),
    task({ id: "task-2", assignee: "impl-1", priority: "low" }),
    task({ id: "task-3", assignee: "impl-1", priority: "high", blockedBy: ["task-1"] }),
    task({ id: "task-4", assignee: "impl-1" }),
    task({ id: "task-5" }),
    task({ id: "task-6", blockedBy: ["task-1"] }),
    task({ id: "task-7", teamId: "team-2", assignee: "impl-1" }),
    task({ id: "task-8", status: "review", assignee: "impl-2" }),
  ]);

  it("queueOf is a member's todo tasks in queue order, this team only", () => {
    expect(queueOf(b, "team-1", "impl-1").map((t) => t.id)).toEqual(["task-3", "task-4", "task-2"]);
  });

  it("nextFor skips the blocked head and hands out the first issuable task", () => {
    expect(nextFor(b, "team-1", "impl-1")?.id).toBe("task-4");
    expect(nextFor(b, "team-1", "impl-2")).toBeNull();
  });

  it("poolOf is the unassigned issuable work", () => {
    expect(poolOf(b, "team-1").map((t) => t.id)).toEqual(["task-5"]);
  });

  it("mine is the open work on a member's plate; who accepts also sees the team's review", () => {
    expect(mine(b, "team-1", "impl-1", "reports").map((t) => t.id)).toEqual([
      "task-3",
      "task-1",
      "task-4",
      "task-2",
    ]);
    expect(mine(b, "team-1", "lead", "leads").map((t) => t.id)).toEqual(["task-8"]);
    expect(mine(b, "team-1", "impl-2", "reports").map((t) => t.id)).toEqual(["task-8"]);
  });
});

describe("counts", () => {
  it("counts every status and sums what waits on a person", () => {
    const tasks = [
      task({ id: "task-1", status: "todo" }),
      task({ id: "task-2", status: "blocked" }),
      task({ id: "task-3", status: "review" }),
      task({ id: "task-4", status: "review" }),
      task({ id: "task-5", status: "done" }),
      task({ id: "task-6", status: "cancelled" }),
    ];
    expect(countByStatus(tasks)).toEqual({ todo: 1, "in-progress": 0, blocked: 1, review: 2, done: 1, cancelled: 1 });
    expect(attentionCount(tasks)).toBe(3);
  });
});
