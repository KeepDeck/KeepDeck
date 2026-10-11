import { describe, expect, it } from "vitest";
import type { StatusCounts } from "../../domain/tasks";
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
  const counts = (over: Partial<StatusCounts>): StatusCounts => ({ backlog: 0, todo: 0, "in-progress": 0, blocked: 0, review: 0, done: 0, cancelled: 0, ...over });

  it("counts done of the work it counts — cancelled work aside — as a count, a bar of status shares and words", () => {
    expect(epicMark(counts({ done: 2, review: 1, "in-progress": 1, todo: 1, cancelled: 4 }))).toEqual({
      chip: "EPIC",
      count: "2/5",
      parts: [
        { tone: "done", share: 40 },
        { tone: "waiting", share: 20 },
        { tone: "working", share: 20 },
      ],
      label: "2 of 5 tasks done — 1 review, 1 in progress, 1 to do",
      summary: "2 of 5 done",
    });
  });

  it("paints every hued status in the board's order from its finished end — blocked last — each its own share", () => {
    const one = epicMark(counts({ backlog: 1, todo: 1, "in-progress": 1, blocked: 1, review: 1, done: 1, cancelled: 1 }));
    expect(one.count).toBe("1/6");
    expect(one.parts).toEqual([
      { tone: "done", share: 100 / 6 },
      { tone: "waiting", share: 100 / 6 },
      { tone: "working", share: 100 / 6 },
      { tone: "failed", share: 100 / 6 },
    ]);
    // The words name the unpainted too, in the same order: blocked last.
    expect(one.label).toBe("1 of 6 tasks done — 1 review, 1 in progress, 1 to do, 1 backlog, 1 blocked");
  });

  it("leaves to do and backlog as bare track — never stretches the painted parts over it", () => {
    expect(epicMark(counts({ done: 1, todo: 1 }))).toMatchObject({ parts: [{ tone: "done", share: 50 }], label: "1 of 2 tasks done — 1 to do" });
    expect(epicMark(counts({ backlog: 1, todo: 1 }))).toMatchObject({ count: "0/2", parts: [], label: "0 of 2 tasks done — 1 to do, 1 backlog" });
    expect(epicMark(counts({ todo: 1, "in-progress": 1 }))).toMatchObject({ parts: [{ tone: "working", share: 50 }], label: "0 of 2 tasks done — 1 in progress, 1 to do" });
    expect(epicMark(counts({ done: 1, todo: 99 })).parts).toEqual([{ tone: "done", share: 1 }]);
  });

  it("keeps a share unrounded: thirds are thirds and fill the track together", () => {
    const { parts } = epicMark(counts({ done: 1, review: 1, "in-progress": 1 }));
    expect(parts.map((part) => part.share)).toEqual([100 / 3, 100 / 3, 100 / 3]);
  });

  it("with nothing counted — no tasks, or only cancelled ones — paints nothing and says 0 of 0", () => {
    for (const nothing of [counts({}), counts({ cancelled: 3 })]) {
      expect(epicMark(nothing)).toEqual({ chip: "EPIC", count: "0/0", parts: [], label: "0 of 0 tasks done", summary: "0 of 0 done" });
    }
    expect(epicMark(counts({ done: 3, cancelled: 1 }))).toMatchObject({ parts: [{ tone: "done", share: 100 }], label: "3 of 3 tasks done" });
  });

  it("is a row's for an epic only", () => {
    const b = board([task({ id: "task-1", kind: "epic" }), task({ id: "task-2", status: "done" })], 3, [relation("child-of", "task-2", "task-1")]);
    expect(taskRowView(b.tasks[0], b, NOW).epic).toMatchObject({ count: "1/1", parts: [{ tone: "done", share: 100 }] });
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
