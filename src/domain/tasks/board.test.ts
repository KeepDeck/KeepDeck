import { describe, expect, it } from "vitest";
import {
  awaitingDecision,
  compareQueue,
  countByStatus,
  issuable,
  keepTeams,
  labelsOf,
} from "./board";
import { openBlockersOf, unblocks } from "./relations";
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

describe("what waits on a decision", () => {
  it("awaitingDecision is the team's review and blocked work, most urgent first", () => {
    const decide = board([
      task({ id: "task-1", status: "review", priority: "low", created: 1 }),
      task({ id: "task-2", status: "blocked", priority: "high", created: 2 }),
      task({ id: "task-3", status: "in-progress" }),
      task({ id: "task-4", status: "review", teamId: "team-2" }),
      task({ id: "task-5", status: "done" }),
    ]);
    expect(awaitingDecision(decide, "team-1").map((t) => t.id)).toEqual(["task-2", "task-1"]);
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
    expect(countByStatus(tasks)).toEqual({ backlog: 0, todo: 1, "in-progress": 0, blocked: 1, review: 2, done: 1, cancelled: 1 });
  });
});

describe("keepTeams", () => {
  const b = board([task({ id: "task-1", teamId: "team-1" }), task({ id: "task-2", teamId: "team-2" })], 7);

  it("keeps only the named teams' tasks, and never hands an id out again", () => {
    const kept = keepTeams(b, new Set(["team-1"]));
    expect(kept.tasks.map((t) => t.id)).toEqual(["task-1"]);
    expect(kept.nextId).toBe(7);
  });

  it("hands the same board back when every task's team is kept — a change is told by reference", () => {
    expect(keepTeams(b, new Set(["team-1", "team-2"]))).toBe(b);
    expect(keepTeams(board([]), new Set())).toEqual(board([]));
  });
});

describe("labelsOf — the board's vocabulary", () => {
  it("is every label a task carries, most used first, then by name; nothing when none", () => {
    const b = board([
      task({ id: "task-1", labels: ["ui", "design"] }),
      task({ id: "task-2", labels: ["ui"] }),
      task({ id: "task-3", labels: ["bell"] }),
      task({ id: "task-4" }),
    ]);
    expect(labelsOf(b)).toEqual(["ui", "bell", "design"]);
    expect(labelsOf(board([task({ id: "task-1" })]))).toEqual([]);
  });

  it("forgets a label once no task carries it", () => {
    expect(labelsOf(board([task({ id: "task-1", labels: [] })]))).toEqual([]);
  });
});
