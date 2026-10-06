import { describe, expect, it } from "vitest";
import { keepTeams } from "./board";
import { RELATION_KINDS } from "./model";
import {
  blockerIdsOf,
  copiedFromOf,
  canHaveEpic,
  copiesOf,
  epicOf,
  openBlockersOf,
  outlives,
  setBlockers,
  setEpic,
  statusOf,
  tasksOfEpic,
  unblocks,
  unlinked,
  transitiveBlockers,
  transitiveWaiters,
  withRelations,
} from "./relations";
import { board, relation, task } from "./testSupport";

describe("relations — reading a board's links", () => {
  it("reads both sides of one link: what a task waits on, and what waits on it", () => {
    const b = board([task({ id: "task-1" }), task({ id: "task-2", blockedBy: ["task-1"] })]);
    expect(blockerIdsOf(b.tasks[1], b)).toEqual(["task-1"]);
    expect(unblocks(b.tasks[0], b).map((t) => t.id)).toEqual(["task-2"]);
    expect(blockerIdsOf(b.tasks[0], b)).toEqual([]);
  });

  it("says a task not on the board is absent — and an absent blocker holds nothing", () => {
    const b = board([task({ id: "task-1" })], 2, [relation("blocks", "task-9", "task-1")]);
    expect(statusOf(b, "uid-task-9")).toBe("absent");
    expect(statusOf(b, "uid-task-1")).toBe("todo");
    expect(openBlockersOf(b.tasks[0], b)).toEqual([]);
    // Nor is it listed as a key: it has none here.
    expect(blockerIdsOf(b.tasks[0], b)).toEqual([]);
  });

  it("gates on open blockers only — done and cancelled hold nothing", () => {
    const b = board([
      task({ id: "task-1", status: "in-progress" }),
      task({ id: "task-2", status: "done" }),
      task({ id: "task-3", status: "cancelled" }),
      task({ id: "task-4", blockedBy: ["task-1", "task-2", "task-3"] }),
    ]);
    expect(openBlockersOf(b.tasks[3], b)).toEqual(["task-1"]);
  });

  it("reads a copy's source and a source's copies, a gone source as absent", () => {
    const b = board([task({ id: "task-1" }), task({ id: "task-2" }), task({ id: "task-3" })], 4, [
      relation("copied-from", "task-2", "task-1"),
      relation("copied-from", "task-3", "task-9"),
    ]);
    expect(copiedFromOf(b.tasks[1], b)).toBe(b.tasks[0]);
    expect(copiesOf(b.tasks[0], b)).toEqual([b.tasks[1]]);
    expect(copiedFromOf(b.tasks[2], b)).toBe("absent");
    expect(copiedFromOf(b.tasks[0], b)).toBeNull();
  });

  it("lists linked tasks in board order — the order they were made — whatever their uids", () => {
    const b = board([
      task({ id: "task-1", uid: "zz" }),
      task({ id: "task-2", uid: "aa" }),
      task({ id: "task-3", blockedBy: ["task-1", "task-2"] }),
    ]);
    expect(blockerIdsOf(b.tasks[2], b)).toEqual(["task-1", "task-2"]);
    expect(openBlockersOf(b.tasks[2], b)).toEqual(["task-1", "task-2"]);
  });

  it("follows what a task waits on, and what that waits on, to find a cycle", () => {
    const b = board([
      task({ id: "task-1", blockedBy: ["task-2"] }),
      task({ id: "task-2", blockedBy: ["task-3"] }),
      task({ id: "task-3" }),
    ]);
    expect([...transitiveBlockers(b, "uid-task-1")].sort()).toEqual(["uid-task-1", "uid-task-2", "uid-task-3"]);
    expect([...transitiveWaiters(b, "uid-task-3")].sort()).toEqual(["uid-task-1", "uid-task-2", "uid-task-3"]);
    expect([...transitiveBlockers(b, "uid-task-3")]).toEqual(["uid-task-3"]);
    // A loop already on the board (one carried over from an old file) is
    // walked once round, not for ever.
    const loop = board([task({ id: "task-1", blockedBy: ["task-2"] }), task({ id: "task-2", blockedBy: ["task-1"] })]);
    expect(transitiveBlockers(loop, "uid-task-1").size).toBe(2);
  });

  it("answers from a fresh board, never a stale one", () => {
    const b = board([task({ id: "task-1" }), task({ id: "task-2" })]);
    expect(blockerIdsOf(b.tasks[1], b)).toEqual([]);
    const linked = setBlockers(b, b.tasks[1], ["uid-task-1"], 5, "lead");
    expect(blockerIdsOf(b.tasks[1], linked)).toEqual(["task-1"]);
    expect(blockerIdsOf(b.tasks[1], b)).toEqual([]);
  });
});

describe("relations — writing them", () => {
  const b = board([task({ id: "task-1" }), task({ id: "task-2" }), task({ id: "task-3", blockedBy: ["task-1"] })]);

  it("sets a task's blockers as a diff: a link that stays keeps who made it and when", () => {
    const set = setBlockers(b, b.tasks[2], ["uid-task-1", "uid-task-2"], 9, "impl-1");
    expect(set.relations).toEqual([
      { kind: "blocks", from: "uid-task-1", to: "uid-task-3", at: 1_000, by: "lead" },
      { kind: "blocks", from: "uid-task-2", to: "uid-task-3", at: 9, by: "impl-1" },
    ]);
    expect(setBlockers(set, set.tasks[2], ["uid-task-2"], 10, "x").relations).toEqual([
      { kind: "blocks", from: "uid-task-2", to: "uid-task-3", at: 9, by: "impl-1" },
    ]);
  });

  it("keeps a blocker not on this board through a change of the rest — it can't be named here, nor taken off", () => {
    const far = board([task({ id: "task-1" }), task({ id: "task-2" })], 3, [relation("blocks", "task-9", "task-2")]);
    const set = setBlockers(far, far.tasks[1], ["uid-task-1"], 9, "lead");
    expect(set.relations.map((r) => r.from)).toEqual(["uid-task-1", "uid-task-9"]);
  });

  it("is the same board when nothing changes", () => {
    expect(setBlockers(b, b.tasks[2], ["uid-task-1"], 9, "x")).toBe(b);
    expect(unlinked(b, () => false)).toBe(b);
  });

  it("keeps links in one order — kind, from, to", () => {
    const shuffled = withRelations(b, [relation("copied-from", "task-1", "task-2"), relation("blocks", "task-2", "task-1"), relation("blocks", "task-1", "task-3")]);
    expect(shuffled.relations.map((r) => [r.kind, r.from, r.to])).toEqual([
      ["blocks", "uid-task-1", "uid-task-3"],
      ["blocks", "uid-task-2", "uid-task-1"],
      ["copied-from", "uid-task-1", "uid-task-2"],
    ]);
  });
});

describe("relations — an epic and its tasks", () => {
  const b = board(
    [
      task({ id: "task-1", kind: "epic" }),
      task({ id: "task-2" }),
      task({ id: "task-3" }),
      task({ id: "task-4" }),
    ],
    5,
    [relation("child-of", "task-3", "task-1"), relation("child-of", "task-2", "task-1"), relation("child-of", "task-4", "task-9")],
  );

  it("reads a task's epic and an epic's tasks from one link, the tasks in board order", () => {
    expect(epicOf(b.tasks[1], b)?.id).toBe("task-1");
    expect(tasksOfEpic(b.tasks[0], b).map((t) => t.id)).toEqual(["task-2", "task-3"]);
    expect(epicOf(b.tasks[0], b)).toBeNull();
  });

  it("puts a task under one epic as a diff — the same epic keeps who and when, the SAME board; another replaces it", () => {
    const work = b.tasks[1];
    expect(setEpic(b, work, "uid-task-1", 9_000, "impl-1")).toBe(b);
    const moved = setEpic(b, work, "uid-task-9", 9_000, "impl-1");
    expect(moved.relations.filter((r) => r.kind === "child-of" && r.from === work.uid)).toEqual([
      { kind: "child-of", from: work.uid, to: "uid-task-9", at: 9_000, by: "impl-1" },
    ]);
    expect(setEpic(moved, work, null, 9_500, null).relations.some((r) => r.kind === "child-of" && r.from === work.uid)).toBe(false);
    expect(setEpic(b, b.tasks[0], null, 1, null)).toBe(b);
  });

  it("walks an epic's tasks before its close in the loop order, both ways — and blockers through it", () => {
    // task-5 waits on the epic task-1; task-2 is under it.
    const walked = board([...b.tasks, task({ id: "task-5", blockedBy: ["task-1"] })], 6, b.relations);
    expect([...transitiveWaiters(walked, "uid-task-2")].sort()).toEqual(["uid-task-1", "uid-task-2", "uid-task-5"]);
    expect([...transitiveBlockers(walked, "uid-task-5")].sort()).toEqual(["uid-task-1", "uid-task-2", "uid-task-3", "uid-task-5"]);
  });

  it("lets work stand under an epic, and no epic — what the link's from end must be", () => {
    expect([canHaveEpic("task"), canHaveEpic("epic")]).toEqual([true, false]);
  });

  it("says a task under an epic not on the board is under none", () => {
    expect(epicOf(b.tasks[3], b)).toBeNull();
  });

  it("takes the link with either end — an epic that left holds no task, a task that left is none of its", () => {
    const link = relation("child-of", "task-2", "task-1");
    expect(outlives(link, new Set(["uid-task-1"]))).toBe(false);
    expect(outlives(link, new Set(["uid-task-2"]))).toBe(false);
    expect(RELATION_KINDS["child-of"]).toEqual({ gatesStart: false, onePerFrom: true, outlivesItsTo: false, ends: { from: "task", to: "epic" }, ordersEnds: true });
  });
});

describe("relations — when tasks leave the board", () => {
  it("drops a link that held something, keeps a fact, and drops one with no end left", () => {
    const gone = new Set(["uid-a"]);
    const blocks = { kind: "blocks", from: "uid-a", to: "uid-b", at: 1, by: null };
    const copy = { kind: "copied-from", from: "uid-b", to: "uid-a", at: 1, by: null };
    expect(outlives(blocks, gone)).toBe(false);
    expect(outlives(copy, gone)).toBe(true);
    // The copy itself gone: the fact about it goes with it.
    expect(outlives(copy, new Set(["uid-b"]))).toBe(false);
    expect(outlives({ ...copy, from: "uid-a", to: "uid-c" }, new Set(["uid-a", "uid-c"]))).toBe(false);
    expect(outlives(blocks, new Set())).toBe(true);
    // A kind this build does not know is not ours to judge: kept while an end is here.
    expect(outlives({ ...blocks, kind: "relates" }, gone)).toBe(true);
    // The rule is the table's.
    expect(RELATION_KINDS.blocks.outlivesItsTo).toBe(false);
    expect(RELATION_KINDS["copied-from"].outlivesItsTo).toBe(true);
  });

  it("takes a disbanded team's links with its tasks — the copy's source link stays, read as gone", () => {
    const b = board(
      [
        task({ id: "task-1", teamId: "team-2" }),
        task({ id: "task-2", blockedBy: ["task-1"] }),
        task({ id: "task-3", teamId: "team-2", blockedBy: ["task-2"] }),
      ],
      4,
      [relation("copied-from", "task-2", "task-1")],
    );
    const kept = keepTeams(b, new Set(["team-1"]));
    expect(kept.tasks.map((t) => t.id)).toEqual(["task-2"]);
    expect(kept.relations).toEqual([relation("copied-from", "task-2", "task-1")]);
    expect(copiedFromOf(kept.tasks[0], kept)).toBe("absent");
    expect(openBlockersOf(kept.tasks[0], kept)).toEqual([]);
    // The copy's own team going takes the fact about it along.
    const copyGone = keepTeams(board([task({ id: "task-1" }), task({ id: "task-2", teamId: "team-2" })], 3, [relation("copied-from", "task-2", "task-1")]), new Set(["team-1"]));
    expect(copyGone.relations).toEqual([]);
    // Nothing leaves: the very same board.
    expect(keepTeams(b, new Set(["team-1", "team-2"]))).toBe(b);
  });
});
