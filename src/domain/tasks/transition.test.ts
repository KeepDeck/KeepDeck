import { describe, expect, it } from "vitest";
import { TASK_CAPS, TASK_STATUSES, USER_ACTOR, blockerResolved, inLadderOrder, isOpen, type TaskActor, type TaskStatus } from "./model";
import { addBlocker, addLabel, attachArtifact, blockerCandidates, blockerLink, createTask, removeBlocker, keptTitle, detachArtifact, duplicateTask, transferTask, removeLabel, reachableStatuses, transition, type TaskChange, type TaskRefusal } from "./transition";
import { blockerIdsOf, copiedFromOf, copiesOf } from "./relations";
import { ROSTER, board, impl1, lead, mintSequence, noTeam, peer1, relation, stranger, task } from "./testSupport";

const ctx = (tasks = [task({ id: "task-1" })]) => ({ board: board(tasks), roster: ROSTER, at: 5_000, mintUid: mintSequence() });

function refusalOf(
  t: ReturnType<typeof task>,
  change: TaskChange,
  actor: TaskActor,
  c = ctx([t]),
): TaskRefusal | null {
  const result = transition(t, change, actor, c);
  return result.ok ? null : result.refusal;
}

function moved(
  t: ReturnType<typeof task>,
  to: TaskStatus,
  actor: TaskActor,
  c = ctx([t]),
) {
  const result = transition(t, { kind: "status", to }, actor, c);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusal)}`);
  return result.task;
}

describe("team boundary", () => {
  it("refuses an agent of another team and one on no team; the user passes", () => {
    const t = task({ id: "task-1", assignee: "impl-1" });
    expect(refusalOf(t, { kind: "comment", body: "hi" }, stranger)).toEqual({ kind: "not-on-team" });
    expect(refusalOf(t, { kind: "comment", body: "hi" }, noTeam)).toEqual({ kind: "not-an-agent-on-a-team" });
    expect(refusalOf(t, { kind: "comment", body: "hi" }, USER_ACTOR)).toBeNull();
  });
});

describe("the ladder", () => {
  it("lets the assignee walk todo → in-progress → blocked → in-progress → review", () => {
    let t = task({ id: "task-1", assignee: "impl-1" });
    t = moved(t, "in-progress", impl1);
    t = moved(t, "blocked", impl1);
    t = moved(t, "in-progress", impl1);
    t = moved(t, "review", impl1);
    expect(t.status).toBe("review");
    expect(t.log.map((e) => `${e.was}→${e.now}`)).toEqual([
      "todo→in-progress",
      "in-progress→blocked",
      "blocked→in-progress",
      "in-progress→review",
    ]);
    expect(t.updated).toBe(5_000);
  });

  it("reserves acceptance, reopening and cancelling for whoever hands out work", () => {
    const inReview = task({ id: "task-1", status: "review", assignee: "impl-1" });
    expect(refusalOf(inReview, { kind: "status", to: "done" }, impl1)).toEqual({ kind: "not-yours-to-move" });
    expect(moved(inReview, "done", lead).status).toBe("done");
    expect(moved(inReview, "in-progress", peer1).status).toBe("in-progress");
    expect(moved(inReview, "done", USER_ACTOR).status).toBe("done");

    const done = task({ id: "task-1", status: "done", assignee: "impl-1" });
    expect(refusalOf(done, { kind: "status", to: "todo" }, impl1)).toEqual({ kind: "not-yours-to-move" });
    expect(moved(done, "todo", lead).status).toBe("todo");
    expect(moved(done, "backlog", lead).status).toBe("backlog");
    expect(moved(task({ id: "task-1", status: "cancelled" }), "backlog", lead).status).toBe("backlog");

    const inProgress = task({ id: "task-1", status: "in-progress", assignee: "impl-1" });
    expect(refusalOf(inProgress, { kind: "status", to: "cancelled" }, impl1)).toEqual({ kind: "not-yours-to-move" });
    expect(moved(inProgress, "cancelled", lead).status).toBe("cancelled");
  });

  it("lets the assignee withdraw its own task from review to finish it — and no one else's", () => {
    const inReview = task({ id: "task-1", status: "review", assignee: "impl-1" });
    expect(moved(inReview, "in-progress", impl1).status).toBe("in-progress");
    const theirs = task({ id: "task-1", status: "review", assignee: "impl-2" });
    expect(refusalOf(theirs, { kind: "status", to: "in-progress" }, impl1)).toEqual({ kind: "not-your-task", assignee: "impl-2" });
  });

  it("keeps a working role on its ladder: no requeue, no pause, no self-block", () => {
    for (const [from, to] of [["in-progress", "todo"], ["review", "backlog"], ["blocked", "todo"], ["todo", "blocked"]] as const) {
      const own = task({ id: "task-1", status: from, assignee: "impl-1" });
      expect(refusalOf(own, { kind: "status", to }, impl1)).toEqual({ kind: "not-yours-to-move" });
    }
  });

  it("refuses every edge the table does not name, and treats no-move as no-op", () => {
    // Acceptance from review only; a closed task reopens into todo or the
    // backlog only; nothing moves between the two closed statuses.
    const cases: [TaskStatus, TaskStatus][] = [
      ["todo", "done"],
      ["in-progress", "done"],
      ["blocked", "done"],
      ["backlog", "done"],
      ["done", "in-progress"],
      ["done", "review"],
      ["cancelled", "blocked"],
      ["cancelled", "done"],
      ["done", "cancelled"],
    ];
    for (const [from, to] of cases) {
      const t = task({ id: "task-1", status: from, assignee: "lead" });
      // The refusal carries where the task CAN go — the same answer the
      // picker reads, so the two cannot disagree.
      expect(refusalOf(t, { kind: "status", to }, lead)).toEqual({
        kind: "illegal-transition",
        from,
        to,
        reachable: reachableStatuses(t, lead, ctx([t])),
      });
    }
    const t = task({ id: "task-1", status: "in-progress", assignee: "lead" });
    const same = transition(t, { kind: "status", to: "in-progress" }, lead, ctx([t]));
    expect(same.ok && same.task).toBe(t);
  });

  it("an illegal move names where the task can go — for THIS actor, blockers counted", () => {
    const t = task({ id: "task-2", assignee: "impl-1" });
    expect(refusalOf(t, { kind: "status", to: "done" }, lead, ctx([t]))).toMatchObject({
      reachable: ["backlog", "in-progress", "blocked", "review", "cancelled"],
    });
    // A working role may not cancel: the start and the parking are its to make.
    expect(refusalOf(t, { kind: "status", to: "done" }, impl1, ctx([t]))).toMatchObject({
      reachable: ["backlog", "in-progress"],
    });
    // An open blocker takes the start away; what is left is still said.
    const blocker = task({ id: "task-1" });
    const held = task({ id: "task-2", assignee: "impl-1", blockedBy: ["task-1"] });
    expect(refusalOf(held, { kind: "status", to: "done" }, impl1, ctx([blocker, held]))).toMatchObject({
      reachable: ["backlog"],
    });
    // A claim is not a move along the ladder: no list rides on it.
    const claimed = refusalOf(task({ id: "task-1", status: "review" }), { kind: "claim" }, impl1);
    expect(claimed).not.toHaveProperty("reachable");
  });

  it("a working role moves only its own task", () => {
    const theirs = task({ id: "task-1", assignee: "impl-2" });
    expect(refusalOf(theirs, { kind: "status", to: "in-progress" }, impl1)).toEqual({
      kind: "not-your-task",
      assignee: "impl-2",
    });
    const theirsDoing = task({ id: "task-1", status: "in-progress", assignee: "impl-2" });
    expect(refusalOf(theirsDoing, { kind: "status", to: "review" }, impl1)).toEqual({
      kind: "not-your-task",
      assignee: "impl-2",
    });
    // The lead moves anyone's.
    expect(moved(theirs, "in-progress", lead).status).toBe("in-progress");
  });

  it("starting a pool task takes it: the assignee is set and logged", () => {
    const pool = task({ id: "task-1" });
    const t = moved(pool, "in-progress", impl1);
    expect(t.assignee).toBe("impl-1");
    expect(t.log.map((e) => e.field)).toEqual(["assignee", "status"]);
    expect(t.log[0]).toMatchObject({ was: null, now: "impl-1", from: "impl-1" });
  });

  it("a working role cannot take a pool task that is not in todo", () => {
    const pooledDoing = task({ id: "task-1", status: "in-progress" });
    expect(refusalOf(pooledDoing, { kind: "status", to: "review" }, impl1)).toEqual({
      kind: "not-your-task",
      assignee: null,
    });
  });

  it("the user walks no ladder: any status from any status, blockers notwithstanding", () => {
    const blocker = task({ id: "task-1", status: "in-progress", assignee: "impl-2" });
    const t = task({ id: "task-2", assignee: "impl-1", blockedBy: ["task-1"] });
    const c = ctx([blocker, t]);
    expect(moved(t, "done", USER_ACTOR, c).status).toBe("done");
    expect(moved(t, "in-progress", USER_ACTOR, c).status).toBe("in-progress");
    const done = task({ id: "task-1", status: "done" });
    expect(moved(done, "in-progress", USER_ACTOR).log[0]).toMatchObject({ from: "user", was: "done", now: "in-progress" });
    expect(reachableStatuses(t, USER_ACTOR, c)).toEqual(["backlog", "in-progress", "blocked", "review", "done", "cancelled"]);
  });

  it("a start waits for every blocker — for the lead too", () => {
    const blocker = task({ id: "task-1", status: "in-progress", assignee: "impl-2" });
    const t = task({ id: "task-2", assignee: "impl-1", blockedBy: ["task-1"] });
    const c = ctx([blocker, t]);
    for (const actor of [impl1, lead]) {
      expect(refusalOf(t, { kind: "status", to: "in-progress" }, actor, c)).toEqual({
        kind: "blocked-by-open",
        blockers: ["task-1"],
      });
    }
    const resumed = task({ id: "task-2", status: "blocked", assignee: "impl-1", blockedBy: ["task-1"] });
    expect(refusalOf(resumed, { kind: "status", to: "in-progress" }, impl1, ctx([blocker, resumed]))).toEqual({
      kind: "blocked-by-open",
      blockers: ["task-1"],
    });
    const cancelled = task({ id: "task-1", status: "cancelled" });
    expect(moved(t, "in-progress", impl1, ctx([cancelled, t])).status).toBe("in-progress");
  });

  it("acceptance waits for every blocker too — every other move steps away from the work and is never held up", () => {
    const blocker = task({ id: "task-1", status: "in-progress", assignee: "impl-2" });
    const inReview = task({ id: "task-2", status: "review", assignee: "impl-1", blockedBy: ["task-1"] });
    const c = ctx([blocker, inReview]);
    expect(refusalOf(inReview, { kind: "status", to: "done" }, lead, c)).toEqual({ kind: "blocked-by-open", blockers: ["task-1"] });
    // The person is held to nothing.
    expect(moved(inReview, "done", USER_ACTOR, c).status).toBe("done");
    for (const to of ["backlog", "todo", "blocked", "cancelled"] as const) {
      expect(moved(inReview, to, lead, c).status).toBe(to);
    }
    // Handing in is not held up either: acceptance is where it waits.
    const doing = task({ id: "task-2", status: "in-progress", assignee: "impl-1", blockedBy: ["task-1"] });
    expect(moved(doing, "review", impl1, ctx([blocker, doing])).status).toBe("review");
    const resolved = task({ id: "task-1", status: "done" });
    expect(moved(inReview, "done", lead, ctx([resolved, inReview])).status).toBe("done");
  });
});

describe("who may move a task where — the whole table", () => {
  const LEAD: Record<TaskStatus, TaskStatus[]> = {
    backlog: ["todo", "in-progress", "blocked", "review", "cancelled"],
    todo: ["backlog", "in-progress", "blocked", "review", "cancelled"],
    "in-progress": ["backlog", "todo", "blocked", "review", "cancelled"],
    blocked: ["backlog", "todo", "in-progress", "review", "cancelled"],
    review: ["backlog", "todo", "in-progress", "blocked", "done", "cancelled"],
    done: ["backlog", "todo"],
    cancelled: ["backlog", "todo"],
  };
  const OWN: Record<TaskStatus, TaskStatus[]> = {
    backlog: ["todo"],
    todo: ["backlog", "in-progress"],
    "in-progress": ["blocked", "review"],
    blocked: ["in-progress"],
    review: ["in-progress"],
    done: [],
    cancelled: [],
  };
  const openBlocker = task({ id: "task-9", status: "in-progress", assignee: "impl-2" });
  const reach = (status: TaskStatus, actor: TaskActor, blocked: boolean) => {
    const t = task({ id: "task-1", status, assignee: "impl-1", blockedBy: blocked ? ["task-9"] : [] });
    return reachableStatuses(t, actor, ctx(blocked ? [openBlocker, t] : [t]));
  };

  it("gives whoever hands out work every move between open statuses, acceptance from review, cancelling and reopening", () => {
    for (const from of TASK_STATUSES) {
      expect([from, reach(from, lead, false)]).toEqual([from, LEAD[from]]);
      expect([from, reach(from, peer1, false)]).toEqual([from, LEAD[from]]);
    }
  });

  it("gives the assignee its ladder on its own task, and nothing on a closed one", () => {
    for (const from of TASK_STATUSES) expect([from, reach(from, impl1, false)]).toEqual([from, OWN[from]]);
  });

  it("holds every agent at an open blocker only when entering work from the queue or a block, and at acceptance", () => {
    const gated = (from: TaskStatus, to: TaskStatus) =>
      (to === "in-progress" && from !== "review") || (from === "review" && to === "done");
    for (const from of TASK_STATUSES) {
      expect([from, reach(from, lead, true)]).toEqual([from, LEAD[from].filter((to) => !gated(from, to))]);
      expect([from, reach(from, impl1, true)]).toEqual([from, OWN[from].filter((to) => !gated(from, to))]);
    }
  });
});

describe("who holds a task after a move", () => {
  it("a pool task is taken by whoever starts it — a working role, the lead or a peer — and only by a start", () => {
    for (const [actor, role] of [[impl1, "impl-1"], [lead, "lead"], [peer1, "peer-1"]] as const) {
      const started = moved(task({ id: "task-1" }), "in-progress", actor);
      expect([role, started.assignee]).toEqual([role, role]);
      expect(started.log[0]).toMatchObject({ field: "assignee", was: null, now: role });
    }
    expect(moved(task({ id: "task-1", status: "backlog" }), "in-progress", lead).assignee).toBe("lead");
    // Parking a pool task is no way to take it — nor is it the worker's to park.
    const pool = task({ id: "task-1" });
    expect(refusalOf(pool, { kind: "status", to: "backlog" }, impl1)).toEqual({ kind: "not-your-task", assignee: null });
    expect(moved(pool, "backlog", lead).assignee).toBeNull();
    // The person takes nothing.
    expect(moved(pool, "in-progress", USER_ACTOR).assignee).toBeNull();
    // Sent back out of review, a pool task is not started: no one takes it.
    expect(moved(task({ id: "task-1", status: "review" }), "in-progress", lead).assignee).toBeNull();
  });

  it("work sent back to the queue goes back to the pool, and the log says who held it", () => {
    for (const from of ["in-progress", "blocked", "review"] as const) {
      for (const to of ["todo", "backlog"] as const) {
        const sent = moved(task({ id: "task-1", status: from, assignee: "impl-1" }), to, lead);
        expect([from, to, sent.assignee]).toEqual([from, to, null]);
        expect(sent.log.map((e) => [e.field, e.was, e.now])).toEqual([
          ["assignee", "impl-1", null],
          ["status", from, to],
        ]);
      }
    }
  });

  it("every other move keeps the holder: its own parking, a reopening, a block, a send-back", () => {
    expect(moved(task({ id: "task-1", assignee: "impl-1" }), "backlog", impl1).assignee).toBe("impl-1");
    expect(moved(task({ id: "task-1", status: "backlog", assignee: "impl-1" }), "todo", lead).assignee).toBe("impl-1");
    expect(moved(task({ id: "task-1", status: "done", assignee: "impl-1" }), "todo", lead).assignee).toBe("impl-1");
    expect(moved(task({ id: "task-1", status: "cancelled", assignee: "impl-1" }), "backlog", lead).assignee).toBe("impl-1");
    expect(moved(task({ id: "task-1", status: "in-progress", assignee: "impl-1" }), "blocked", lead).assignee).toBe("impl-1");
    expect(moved(task({ id: "task-1", status: "review", assignee: "impl-1" }), "in-progress", lead).assignee).toBe("impl-1");
  });

  it("a send-back or a withdrawal from review is never held up by a blocker", () => {
    const blocker = task({ id: "task-9", status: "in-progress", assignee: "impl-2" });
    const inReview = task({ id: "task-1", status: "review", assignee: "impl-1", blockedBy: ["task-9"] });
    const c = ctx([blocker, inReview]);
    expect(moved(inReview, "in-progress", lead, c).status).toBe("in-progress");
    expect(moved(inReview, "in-progress", impl1, c).status).toBe("in-progress");
  });
});

describe("the backlog — work parked, not yet to be started", () => {
  it("is parked and unparked by the assignee on its own task, the lead on any; cancelled by the lead", () => {
    const own = task({ id: "task-1", assignee: "impl-1" });
    expect(moved(own, "backlog", impl1).status).toBe("backlog");
    const parked = task({ id: "task-1", status: "backlog", assignee: "impl-1" });
    expect(moved(parked, "todo", impl1).status).toBe("todo");
    expect(reachableStatuses(parked, impl1, ctx([parked]))).toEqual(["todo"]);
    expect(reachableStatuses(parked, lead, ctx([parked]))).toEqual(["todo", "in-progress", "blocked", "review", "cancelled"]);
    // Not another worker's task, nor a pool one: no one holds it to move.
    const theirs = task({ id: "task-1", status: "backlog", assignee: "impl-2" });
    expect(refusalOf(theirs, { kind: "status", to: "todo" }, impl1, ctx([theirs]))).toMatchObject({ kind: "not-your-task" });
    const pool = task({ id: "task-1", status: "backlog" });
    expect(refusalOf(pool, { kind: "status", to: "todo" }, impl1, ctx([pool]))).toMatchObject({ kind: "not-your-task" });
    // Its assignee never starts it from the backlog: moved to todo first.
    // Straight into work from there is the lead's move to make.
    expect(refusalOf(parked, { kind: "status", to: "in-progress" }, impl1, ctx([parked]))).toEqual({ kind: "not-yours-to-move" });
    expect(moved(parked, "in-progress", lead).status).toBe("in-progress");
  });

  it("is created there when asked, by anyone; todo by default", () => {
    const parked = createTask({ teamId: "team-1", title: "Idea", status: "backlog" }, impl1, ctx([]));
    expect(parked.ok && parked.task.status).toBe("backlog");
    const plain = createTask({ teamId: "team-1", title: "Work" }, lead, ctx([]));
    expect(plain.ok && plain.task.status).toBe("todo");
  });

  it("is created in todo or the backlog — anything else is refused, by the domain itself", () => {
    const done = createTask({ teamId: "team-1", title: "x", status: "done" as never }, lead, ctx([]));
    expect(done.ok ? null : done.refusal).toEqual({ kind: "bad-create-status", status: "done", allowed: ["todo", "backlog"] });
  });

  it("keeps a title on one line: a pasted line break is a space", () => {
    const made = createTask({ teamId: "team-1", title: "Line one\n  line two\r\n" }, lead, ctx([]));
    expect(made.ok && made.task.title).toBe("Line one line two");
    expect(keptTitle(" a\nb ")).toBe("a b");
  });

  it("reads a set of statuses in ladder order, each once, known ones only", () => {
    expect(inLadderOrder(["done", "nope", "backlog", "done", 7])).toEqual(["backlog", "done"]);
  });

  it("may name whom it is meant for: assigned while parked, its assignee unparks it to start", () => {
    const parked = task({ id: "task-1", status: "backlog" });
    const theirs = transition(parked, { kind: "assign", assignee: "impl-1" }, lead, ctx([parked]));
    expect(theirs.ok && theirs.task.assignee).toBe("impl-1");
    const held = theirs.ok ? theirs.task : parked;
    expect(moved(held, "todo", impl1).status).toBe("todo");
  });

  it("holds its dependants: a parked prerequisite is not done", () => {
    expect(blockerResolved("backlog")).toBe(false);
    expect(isOpen("backlog")).toBe(true);
  });
});

describe("reachableStatuses", () => {
  it("lists, in ladder order, exactly the rungs the actor may move to", () => {
    const t = task({ id: "task-1", assignee: "impl-1" });
    expect(reachableStatuses(t, impl1, ctx([t]))).toEqual(["backlog", "in-progress"]);
    expect(reachableStatuses(t, lead, ctx([t]))).toEqual(["backlog", "in-progress", "blocked", "review", "cancelled"]);
    const inReview = task({ id: "task-1", status: "review", assignee: "impl-1" });
    expect(reachableStatuses(inReview, lead, ctx([inReview]))).toEqual(["backlog", "todo", "in-progress", "blocked", "done", "cancelled"]);
    expect(reachableStatuses(inReview, impl1, ctx([inReview]))).toEqual(["in-progress"]);
    const done = task({ id: "task-1", status: "done", assignee: "impl-1" });
    expect(reachableStatuses(done, lead, ctx([done]))).toEqual(["backlog", "todo"]);
    expect(reachableStatuses(done, impl1, ctx([done]))).toEqual([]);
  });
});

describe("claim", () => {
  it("gives a pool task to the agent without starting it", () => {
    const result = transition(task({ id: "task-1" }), { kind: "claim" }, impl1, ctx());
    expect(result.ok && result.task).toMatchObject({ assignee: "impl-1", status: "todo" });
    expect(result.ok && result.task.log).toEqual([
      { at: 5_000, from: "impl-1", field: "assignee", was: null, now: "impl-1" },
    ]);
  });

  it("refuses a task somebody else holds, an unstarted one behind a blocker, and a non-agent", () => {
    expect(refusalOf(task({ id: "task-1", assignee: "impl-2" }), { kind: "claim" }, impl1)).toEqual({
      kind: "already-claimed",
      assignee: "impl-2",
    });
    const blocker = task({ id: "task-1" });
    const t = task({ id: "task-2", blockedBy: ["task-1"] });
    expect(refusalOf(t, { kind: "claim" }, impl1, ctx([blocker, t]))).toEqual({
      kind: "blocked-by-open",
      blockers: ["task-1"],
    });
    expect(refusalOf(task({ id: "task-1" }), { kind: "claim" }, USER_ACTOR)).toEqual({
      kind: "claim-needs-an-agent",
    });
    expect(refusalOf(task({ id: "task-1", status: "review" }), { kind: "claim" }, impl1)).toEqual({
      kind: "illegal-transition",
      from: "review",
      to: "in-progress",
    });
  });

  it("is a no-op on a task the agent already holds", () => {
    const t = task({ id: "task-1", assignee: "impl-1" });
    const result = transition(t, { kind: "claim" }, impl1, ctx([t]));
    expect(result.ok && result.task).toBe(t);
  });
});

describe("fields only the lead sets", () => {
  const t = task({ id: "task-1", assignee: "impl-1" });

  it("refuses a working role by field name", () => {
    expect(refusalOf(t, { kind: "assign", assignee: "impl-2" }, impl1)).toEqual({ kind: "not-yours-to-assign", field: "assignee" });
    expect(refusalOf(t, { kind: "priority", to: "high" }, impl1)).toEqual({ kind: "not-yours-to-assign", field: "priority" });
    expect(refusalOf(t, { kind: "title", to: "x" }, impl1)).toEqual({ kind: "not-yours-to-assign", field: "title" });
    expect(refusalOf(t, { kind: "body", to: "x" }, impl1)).toEqual({ kind: "not-yours-to-assign", field: "body" });
    expect(refusalOf(t, { kind: "blockedBy", to: [] }, impl1)).toEqual({ kind: "not-yours-to-assign", field: "blockedBy" });
  });

  it("assign checks the roster and logs the move; the pool is a legal target", () => {
    expect(refusalOf(t, { kind: "assign", assignee: "ghost-1" }, lead)).toEqual({
      kind: "assignee-not-on-team",
      assignee: "ghost-1",
    });
    const result = transition(t, { kind: "assign", assignee: null }, lead, ctx([t]));
    expect(result.ok && result.task.assignee).toBeNull();
    expect(result.ok && result.task.log[0]).toMatchObject({ field: "assignee", was: "impl-1", now: null, from: "lead" });
  });

  it("title and comment refuse blank and over-cap text; body refuses over-cap", () => {
    expect(refusalOf(t, { kind: "title", to: "   " }, lead)).toEqual({ kind: "blank", field: "title" });
    expect(refusalOf(t, { kind: "title", to: "x".repeat(TASK_CAPS.titleMax + 1) }, lead)).toEqual({
      kind: "field-cap",
      field: "title",
      max: TASK_CAPS.titleMax,
      length: TASK_CAPS.titleMax + 1,
    });
    // Characters, not UTF-16 units: an emoji counts once.
    expect(refusalOf(t, { kind: "title", to: "👍".repeat(TASK_CAPS.titleMax) }, lead)).toBeNull();
    // Measured as kept: spaces at the ends do not count.
    expect(refusalOf(t, { kind: "title", to: `  ${"x".repeat(TASK_CAPS.titleMax)}  ` }, lead)).toBeNull();
    expect(refusalOf(t, { kind: "body", to: "x".repeat(TASK_CAPS.bodyMax + 1) }, lead)).toEqual({
      kind: "field-cap",
      field: "body",
      max: TASK_CAPS.bodyMax,
      length: TASK_CAPS.bodyMax + 1,
    });
    expect(refusalOf(t, { kind: "comment", body: " " }, impl1)).toEqual({ kind: "blank", field: "comment" });
    expect(refusalOf(t, { kind: "comment", body: "x".repeat(TASK_CAPS.commentMax + 1) }, impl1)).toEqual({
      kind: "field-cap",
      field: "comment",
      max: TASK_CAPS.commentMax,
      length: TASK_CAPS.commentMax + 1,
    });
  });

  it("blockedBy must name existing tasks of the same team, never itself, never a cycle", () => {
    const a = task({ id: "task-1", assignee: "impl-1" });
    const b = task({ id: "task-2", blockedBy: ["task-1"] });
    const foreign = task({ id: "task-3", teamId: "team-2" });
    const c = ctx([a, b, foreign]);
    expect(refusalOf(a, { kind: "blockedBy", to: ["task-9"] }, lead, c)).toEqual({ kind: "unknown-blocker", ids: ["task-9"] });
    expect(refusalOf(a, { kind: "blockedBy", to: ["task-3"] }, lead, c)).toEqual({ kind: "cross-team-blocker", ids: ["task-3"] });
    expect(refusalOf(a, { kind: "blockedBy", to: ["task-1"] }, lead, c)).toEqual({ kind: "self-blocker" });
    // task-2 waits on task-1; making task-1 wait on task-2 closes the loop.
    expect(refusalOf(a, { kind: "blockedBy", to: ["task-2"] }, lead, c)).toEqual({ kind: "cyclic-blocker", ids: ["task-2"] });
    const ok = transition(b, { kind: "blockedBy", to: [" task-1 ", "task-1"] }, lead, c);
    expect(ok.ok && ok.task).toBe(b); // normalised to what it already was: no-op
  });

  it("offers as blockers exactly what the change would take: the team's open tasks, not itself, none twice, none in a cycle", () => {
    const t = task({ id: "task-1", blockedBy: ["task-2"] });
    const tasks = [
      t,
      task({ id: "task-2" }),
      task({ id: "task-3" }),
      task({ id: "task-4", status: "done" }),
      task({ id: "task-5", teamId: "team-2" }),
      task({ id: "task-6", blockedBy: ["task-1"] }),
      // task-7 waits on task-8, which waits on task-1: task-1 waiting on
      // task-7 would close a loop, task-7 waiting on task-1 would not.
      task({ id: "task-7", blockedBy: ["task-8"] }),
      task({ id: "task-8", blockedBy: ["task-1"] }),
    ];
    const b = board(tasks);
    expect(blockerCandidates(b.tasks[0], b).map((x) => x.id)).toEqual(["task-3"]);
    // The other side: what could wait on task-1 — not task-2, which it
    // waits on (a cycle), nor task-6 and task-8, which already do.
    expect(blockerCandidates(b.tasks[0], b, "blocks").map((x) => x.id)).toEqual(["task-3", "task-7"]);
  });

  it("answers on a long chain at once — one walk, no recursion to overflow", () => {
    // task-1 waits on task-2, which waits on task-3, … down to task-2000.
    const length = 2000;
    const chain = Array.from({ length }, (_, i) =>
      task({ id: `task-${i + 1}`, blockedBy: i + 1 < length ? [`task-${i + 2}`] : [] }),
    );
    const b = board(chain);
    const middle = b.tasks[1000];
    const started = performance.now();
    const waitsOn = blockerCandidates(middle, b, "blocked-by");
    const waitedBy = blockerCandidates(middle, b, "blocks");
    expect(performance.now() - started).toBeLessThan(500);
    // It may wait on nothing above it (they wait on it), and on everything
    // below but the one it already waits on.
    expect(waitsOn.map((t) => t.id)).not.toContain("task-1");
    expect(waitsOn).toHaveLength(length - 1001 - 1);
    // Anything above may wait on it, but the one already does; nothing below may.
    expect(waitedBy).toHaveLength(1000 - 1);
    expect(waitedBy.map((t) => t.id)).not.toContain("task-2000");
  });

  it("links on the waiting task, whichever side the link was asked from", () => {
    const [a, b] = [task({ id: "task-1" }), task({ id: "task-2" })];
    expect(blockerLink(a, b, "blocked-by")).toEqual({ taskId: "task-1", change: addBlocker("task-2") });
    expect(blockerLink(a, b, "blocks")).toEqual({ taskId: "task-2", change: addBlocker("task-1") });
  });

  it("adds and removes one blocker on the blockers as they stand when the change lands", () => {
    const t = task({ id: "task-3" });
    const c = ctx([task({ id: "task-1" }), task({ id: "task-2" }), t]);
    const one = transition(t, addBlocker("task-1"), lead, c);
    if (!one.ok) throw new Error("refused");
    const two = transition(one.task, addBlocker("task-2"), lead, { ...c, board: one.board });
    if (!two.ok) throw new Error("refused");
    expect(blockerIdsOf(two.task, two.board)).toEqual(["task-1", "task-2"]);
    const off = transition(two.task, removeBlocker("task-1"), lead, { ...c, board: two.board });
    expect(off.ok && blockerIdsOf(off.task, off.board)).toEqual(["task-2"]);
    // By the change's own rules: a working role may not, a cycle may not.
    expect(refusalOf(t, addBlocker("task-1"), impl1, c)).toEqual({ kind: "not-yours-to-assign", field: "blockedBy" });
  });

  it("logs a set of blockers in board order, whatever order it was named in", () => {
    const t = task({ id: "task-3" });
    const c = ctx([task({ id: "task-1" }), task({ id: "task-2" }), t]);
    const set = transition(t, { kind: "blockedBy", to: ["task-2", "task-1"] }, lead, c);
    expect(set.ok && set.task.log[set.task.log.length - 1]).toMatchObject({ field: "blockedBy", was: null, now: "task-1,task-2" });
  });
});

describe("what every member may do", () => {
  it("keeps every comment — past where the board once cut them — with ordinals that never repeat", () => {
    let t = task({ id: "task-1", assignee: "impl-2" });
    const many = 250;
    for (let i = 0; i < many; i += 1) {
      const result = transition(t, { kind: "comment", body: `note ${i}` }, impl1, ctx([t]));
      if (!result.ok) throw new Error("refused");
      t = result.task;
    }
    expect(t.comments).toHaveLength(many);
    expect(t.comments.map((c) => c.n)).toEqual(Array.from({ length: many }, (_, i) => i + 1));
    expect(t.comments[0]).toMatchObject({ from: "impl-1", body: "note 0" });
  });

  it("any member attaches artifacts; the user signs as `user`", () => {
    const t = task({ id: "task-1", assignee: "impl-2" });
    const byPeer = transition(t, { kind: "artifacts", to: ["kd-tasks", "", "kd-tasks"] }, impl1, ctx([t]));
    expect(byPeer.ok && byPeer.task.artifacts).toEqual(["kd-tasks"]);
    const byUser = transition(t, { kind: "comment", body: "looks right" }, USER_ACTOR, ctx([t]));
    expect(byUser.ok && byUser.task.comments[0].from).toBe("user");
  });

  it("a brief edit keeps the previous brief as a version, and the log says which replaced which", () => {
    const t = task({ id: "task-1", assignee: "lead", body: "first" });
    const once = transition(t, { kind: "body", to: "second" }, lead, ctx([t]));
    if (!once.ok) throw new Error("refused");
    expect(once.task).toMatchObject({ body: "second", bodyV: 2, briefs: [{ v: 1, body: "first" }] });
    // Who and when is the log's; the log holds no brief text.
    expect(once.task.log).toEqual([{ at: 5_000, from: "lead", field: "body", was: "1", now: "2" }]);
    const twice = transition(once.task, { kind: "body", to: "third" }, lead, ctx([once.task]));
    if (!twice.ok) throw new Error("refused");
    expect(twice.task.briefs).toEqual([{ v: 1, body: "first" }, { v: 2, body: "second" }]);
    expect(twice.task.bodyV).toBe(3);
    // The same brief again is no edit: no version, no log line.
    const same = transition(twice.task, { kind: "body", to: "third" }, lead, ctx([twice.task]));
    expect(same.ok && same.task).toBe(twice.task);
  });

  it("keeps the whole log — past where the board once cut it — oldest first", () => {
    let t = task({ id: "task-1", assignee: "lead" });
    const many = 520;
    for (let i = 0; i < many; i += 1) {
      const result = transition(t, { kind: "priority", to: i % 2 ? "high" : "low" }, lead, ctx([t]));
      if (!result.ok) throw new Error("refused");
      t = result.task;
    }
    expect(t.log).toHaveLength(many);
    expect(t.log[0]).toMatchObject({ field: "priority", now: "low" });
  });
});

describe("createTask", () => {
  const empty = { board: board([]), roster: ROSTER, at: 7_000, mintUid: mintSequence() };

  it("mints task-N from the board's counter and advances it", () => {
    const first = createTask({ teamId: "team-1", title: "  Draft the skill " }, lead, empty);
    if (!first.ok) throw new Error("refused");
    expect(first.task).toMatchObject({
      id: "task-1",
      title: "Draft the skill",
      status: "todo",
      priority: "normal",
      assignee: null,
      author: "lead",
      created: 7_000,
    });
    expect(first.board.nextId).toBe(2);
    // Its own identity, drawn once — what a link to it names.
    expect(first.task.uid).toBe("uid-new-1");
    const second = createTask({ teamId: "team-1", title: "Next" }, USER_ACTOR, { ...empty, board: first.board });
    expect(second.ok && second.task.id).toBe("task-2");
    expect(second.ok && second.task.author).toBe("user");
  });

  it("a working role creates for itself or the pool at the default priority only", () => {
    expect(createTask({ teamId: "team-1", title: "x", assignee: "impl-1" }, impl1, empty).ok).toBe(true);
    expect(createTask({ teamId: "team-1", title: "x" }, impl1, empty).ok).toBe(true);
    const other = createTask({ teamId: "team-1", title: "x", assignee: "impl-2" }, impl1, empty);
    expect(!other.ok && other.refusal).toEqual({ kind: "not-yours-to-assign", field: "assignee" });
    const urgent = createTask({ teamId: "team-1", title: "x", priority: "high" }, impl1, empty);
    expect(!urgent.ok && urgent.refusal).toEqual({ kind: "not-yours-to-assign", field: "priority" });
    const byLead = createTask({ teamId: "team-1", title: "x", assignee: "impl-2", priority: "high" }, lead, empty);
    expect(byLead.ok).toBe(true);
  });

  it("checks team, roster and blockers — and creates on a board of any size", () => {
    const foreign = createTask({ teamId: "team-1", title: "x" }, stranger, empty);
    expect(!foreign.ok && foreign.refusal).toEqual({ kind: "not-on-team" });
    const ghost = createTask({ teamId: "team-1", title: "x", assignee: "ghost" }, lead, empty);
    expect(!ghost.ok && ghost.refusal).toEqual({ kind: "assignee-not-on-team", assignee: "ghost" });
    const unknown = createTask({ teamId: "team-1", title: "x", blockedBy: ["task-4"] }, lead, empty);
    expect(!unknown.ok && unknown.refusal).toEqual({ kind: "unknown-blocker", ids: ["task-4"] });
    // No cap on how many: a board past the 2000 it once refused still takes one more.
    const big = { ...empty, board: board(Array.from({ length: 2001 }, (_, i) => task({ id: `task-${i + 1}` })), 2002) };
    expect(createTask({ teamId: "team-1", title: "x" }, lead, big).ok).toBe(true);
    const edge = { ...empty, board: { nextId: Number.MAX_SAFE_INTEGER, tasks: [], relations: [] } };
    const exhausted = createTask({ teamId: "team-1", title: "x" }, lead, edge);
    expect(!exhausted.ok && exhausted.refusal).toEqual({ kind: "counter-exhausted" });
  });
});

describe("attachArtifact / detachArtifact", () => {
  const t = task({ id: "task-1", artifacts: ["kd-a", "kd-b"] });

  it("attaches a slug; attaching one already there changes nothing once the transition applies it", () => {
    expect(attachArtifact(t, "kd-c")).toEqual({ kind: "artifacts", to: ["kd-a", "kd-b", "kd-c"] });
    // The one normalization rule is the transition's: a repeat is folded
    // there, and the task comes back as it was.
    const again = transition(t, attachArtifact(t, "kd-a"), lead, ctx([t]));
    expect(again.ok && again.task).toBe(t);
  });

  it("detaches only the slug named, and a slug not attached leaves the list as it is", () => {
    expect(detachArtifact(t, "kd-a")).toEqual({ kind: "artifacts", to: ["kd-b"] });
    expect(detachArtifact(t, "kd-z")).toEqual({ kind: "artifacts", to: ["kd-a", "kd-b"] });
  });
});

describe("labels", () => {
  const labelled = (t: ReturnType<typeof task>, to: string[], actor: TaskActor) => {
    const result = transition(t, { kind: "labels", to }, actor, ctx([t]));
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusal)}`);
    return result.task;
  };

  it("keeps words: trimmed, lowercased, spaces and underscores a dash, deduped and sorted", () => {
    const t = task({ id: "task-1" });
    expect(labelled(t, ["  Copy Edit ", "ui", "UI", "big__deal", "-dash-"], lead).labels).toEqual([
      "big-deal",
      "copy-edit",
      "dash",
      "ui",
    ]);
    // Words in any script, digits included.
    expect(labelled(t, ["Дизайн", "v2"], lead).labels).toEqual(["v2", "дизайн"]);
  });

  it("reads a word in any script as one spelling — composed, its marks kept, counted in characters", () => {
    const t = task({ id: "task-1" });
    // A decomposed é and a full-width year are their plain spelling.
    expect(labelled(t, ["cafe\u0301", "２０２６"], lead).labels).toEqual(["2026", "café"]);
    expect(labelled(t, ["café", "cafe\u0301"], lead).labels).toEqual(["café"]);
    // Scripts written with marks on their letters, and the dot İ keeps.
    expect(labelled(t, ["हिन्दी", "עִברית", "İş"], lead).labels).toHaveLength(3);
    // Spelled with zero-width joiners: Persian's ZWNJ, a Devanagari conjunct.
    expect(labelled(t, ["می\u200cخواهم", "क\u094d\u200dष"], lead).labels).toHaveLength(2);
    // Characters, not UTF-16 units: an ideograph beyond the basic plane is one.
    expect(refusalOf(t, { kind: "labels", to: ["𠀀".repeat(TASK_CAPS.labelMax)] }, lead)).toBeNull();
    // A mark is no word's start.
    expect(refusalOf(t, { kind: "labels", to: ["\u0301a"] }, lead)).toMatchObject({ kind: "bad-label" });
  });

  it("refuses a label that is not a word, or one too long, naming it", () => {
    const t = task({ id: "task-1" });
    expect(refusalOf(t, { kind: "labels", to: ["ok", "a/b"] }, lead)).toEqual({
      kind: "bad-label",
      label: "a/b",
      max: TASK_CAPS.labelMax,
    });
    expect(refusalOf(t, { kind: "labels", to: ["   "] }, lead)).toMatchObject({ kind: "bad-label", label: "" });
    const long = "x".repeat(TASK_CAPS.labelMax + 1);
    expect(refusalOf(t, { kind: "labels", to: [long] }, lead)).toMatchObject({ kind: "bad-label", label: long });
    expect(refusalOf(t, { kind: "labels", to: ["x".repeat(TASK_CAPS.labelMax)] }, lead)).toBeNull();
  });

  it("refuses more than the cap — counted after the duplicates fold", () => {
    const t = task({ id: "task-1" });
    const five = ["a", "b", "c", "d", "e"];
    expect(refusalOf(t, { kind: "labels", to: [...five, "A"] }, lead)).toBeNull();
    expect(refusalOf(t, { kind: "labels", to: [...five, "f"] }, lead)).toEqual({
      kind: "too-many-labels",
      max: TASK_CAPS.labelsMax,
    });
  });

  it("is the lead's and the user's on any task, and the assignee's on its own — not another worker's", () => {
    const own = task({ id: "task-1", assignee: "impl-1" });
    const theirs = task({ id: "task-1", assignee: "impl-2" });
    expect(refusalOf(own, { kind: "labels", to: ["ui"] }, impl1)).toBeNull();
    expect(refusalOf(theirs, { kind: "labels", to: ["ui"] }, impl1)).toEqual({ kind: "not-yours-to-label", assignee: "impl-2" });
    expect(refusalOf(task({ id: "task-1" }), { kind: "labels", to: ["ui"] }, impl1)).toEqual({ kind: "not-yours-to-label", assignee: null });
    expect(refusalOf(theirs, { kind: "labels", to: ["ui"] }, lead)).toBeNull();
    expect(refusalOf(theirs, { kind: "labels", to: ["ui"] }, USER_ACTOR)).toBeNull();
  });

  it("logs the set as it was and as it is; a reordering or a repeat is no edit", () => {
    const t = task({ id: "task-1", labels: ["design", "ui"] });
    const edited = labelled(t, ["ui"], lead);
    expect(edited.log[edited.log.length - 1]).toEqual({ at: 5_000, from: "lead", field: "labels", was: "design,ui", now: "ui" });
    expect(labelled(t, ["UI", "design"], lead)).toBe(t);
    expect(labelled(task({ id: "task-1" }), ["ui"], lead).log[0]).toMatchObject({ was: null, now: "ui" });
  });

  it("takes them at creation by the same rule", () => {
    const made = createTask({ teamId: "team-1", title: "x", labels: ["Copy Edit", "ui", "ui"] }, lead, ctx([]));
    expect(made.ok && made.task.labels).toEqual(["copy-edit", "ui"]);
    expect(createTask({ teamId: "team-1", title: "x" }, lead, ctx([])).ok && true).toBe(true);
    const bad = createTask({ teamId: "team-1", title: "x", labels: ["a b/c"] }, lead, ctx([]));
    expect(bad.ok ? null : bad.refusal.kind).toBe("bad-label");
  });

  it("lets a working role label at creation only what it then holds", () => {
    const own = createTask({ teamId: "team-1", title: "x", assignee: "impl-1", labels: ["ui"] }, impl1, ctx([]));
    expect(own.ok).toBe(true);
    const pool = createTask({ teamId: "team-1", title: "x", labels: ["ui"] }, impl1, ctx([]));
    expect(pool.ok ? null : pool.refusal).toEqual({ kind: "not-yours-to-label", assignee: null });
    expect(createTask({ teamId: "team-1", title: "x" }, impl1, ctx([])).ok).toBe(true);
  });
});

describe("addLabel / removeLabel — the changes the open task's label field makes", () => {
  const t = task({ id: "task-1", labels: ["design", "ui"] });

  const applied = (on: ReturnType<typeof task>, change: ReturnType<typeof addLabel>, actor: TaskActor = lead) => {
    const result = transition(on, change, actor, ctx([on]));
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusal)}`);
    return result.task;
  };

  it("adds to the set as it stands when the change lands, by the set's own rule", () => {
    expect(applied(t, addLabel("Copy Edit")).labels).toEqual(["copy-edit", "design", "ui"]);
    expect(applied(t, addLabel("UI"))).toBe(t);
    // Someone else's label put on meanwhile stays: the change names one.
    const meanwhile = task({ id: "task-1", labels: ["design", "ui", "urgent"] });
    expect(applied(meanwhile, addLabel("copy")).labels).toEqual(["copy", "design", "ui", "urgent"]);
    expect(refusalOf(t, addLabel("a/b"), lead)).toMatchObject({ kind: "bad-label" });
    expect(refusalOf(t, addLabel("ui"), impl1)).toMatchObject({ kind: "not-yours-to-label" });
  });

  it("takes one off by name, however it is spelled, leaving the rest as they stand", () => {
    expect(applied(t, removeLabel("design")).labels).toEqual(["ui"]);
    expect(applied(t, removeLabel(" Design ")).labels).toEqual(["ui"]);
    const meanwhile = task({ id: "task-1", labels: ["design", "ui", "urgent"] });
    expect(applied(meanwhile, removeLabel("design")).labels).toEqual(["ui", "urgent"]);
  });
});

describe("duplicateTask — a fresh copy, its own history", () => {
  const source = task({
    id: "task-1",
    title: "Draft the copy",
    body: "the brief",
    priority: "high",
    assignee: "impl-1",
    status: "review",
    labels: ["copy", "ui"],
    artifacts: ["kd-a"],
    blockedBy: ["task-2", "task-3"],
    comments: [{ n: 1, at: 1, from: "lead", body: "go" }],
    log: [{ at: 1, from: "lead", field: "status", was: "todo", now: "in-progress" }],
  });
  const blocker = task({ id: "task-2", status: "in-progress" });
  const resolved = task({ id: "task-3", status: "done" });
  const at = (actor: TaskActor) => duplicateTask(source, actor, { ...ctx([source, blocker, resolved]), at: 9_000 });

  it("copies the work and none of its history, held by no one, in todo", () => {
    const made = at(lead);
    if (!made.ok) throw new Error("refused");
    expect(made.task).toMatchObject({
      // The source's own title: the link, not a mark in the words, says
      // which is the copy (it is in the open task, `copiedFromOf`).
      title: "Draft the copy",
      body: "the brief",
      priority: "high",
      assignee: null,
      status: "todo",
      labels: ["copy", "ui"],
      artifacts: ["kd-a"],
      comments: [],
      teamId: source.teamId,
    });
    expect(made.task.id).not.toBe(source.id);
    // Only the blockers that still hold: a done one holds nothing.
    expect(blockerIdsOf(made.task, made.board)).toEqual(["task-2"]);
    // The copy is linked to its source — a fact, made only here.
    expect(made.board.relations).toContainEqual({ kind: "copied-from", from: made.task.uid, to: source.uid, at: 9_000, by: "lead" });
    expect(copiedFromOf(made.task, made.board)).toBe(made.source);
    expect(copiesOf(made.source, made.board)).toEqual([made.task]);
    // Each end says so: the copy where it came from, the source where it went.
    expect(made.task.log).toEqual([{ at: 9_000, from: "lead", field: "copiedFrom", was: null, now: "task-1" }]);
    expect(made.source.log[made.source.log.length - 1]).toEqual({ at: 9_000, from: "lead", field: "copiedTo", was: null, now: made.task.id });
    expect(made.board.tasks.find((t) => t.id === "task-1")).toBe(made.source);
    // Nearly a read: the source's date stays, so an old task is not lifted.
    expect(made.source.updated).toBe(source.updated);
    expect(made.notCarried).toEqual([]);
  });

  it("copies a copy under the same title, linked to the copy it was made from — nothing stacks, nothing is cut", () => {
    const long = { ...source, title: "x".repeat(TASK_CAPS.titleMax) };
    const first = duplicateTask(long, lead, ctx([long, blocker, resolved]));
    if (!first.ok) throw new Error("refused");
    const second = duplicateTask(first.task, lead, { ...ctx([]), board: first.board });
    if (!second.ok) throw new Error("refused");
    expect(second.task.title).toBe(long.title);
    expect(copiedFromOf(second.task, second.board)).toMatchObject({ id: first.task.id });
  });

  it("parks the copy of a parked task", () => {
    const parked = { ...source, status: "backlog" as const };
    const made = duplicateTask(parked, lead, ctx([parked, blocker, resolved]));
    expect(made.ok && made.task.status).toBe("backlog");
  });

  it("keeps a working role's copy within what it may set: normal priority, no labels on a pool task", () => {
    const made = at(impl1);
    expect(made.ok && [made.task.priority, made.task.labels]).toEqual(["normal", []]);
    // And says what it left, for whoever asked to tell them.
    expect(made.ok && made.notCarried).toEqual([
      { field: "priority", was: "high" },
      { field: "labels", was: "copy,ui" },
    ]);
  });
});

describe("transferTask — the same task, handed to another team", () => {
  const teams = { from: { id: "team-1", name: "api" }, to: { id: "team-2", name: "web" } };
  const go = (t: ReturnType<typeof task>, actor: TaskActor, others: ReturnType<typeof task>[] = []) =>
    transferTask(t, teams, actor, { ...ctx([t, ...others]), at: 9_000 });

  it("keeps the task — its id, words and history — and hands it over unheld, back at todo", () => {
    const t = task({
      id: "task-1",
      status: "review",
      assignee: "impl-1",
      priority: "high",
      labels: ["ui"],
      comments: [{ n: 1, at: 1, from: "lead", body: "go" }],
    });
    const moved = go(t, lead);
    if (!moved.ok) throw new Error("refused");
    expect(moved.task).toMatchObject({ id: "task-1", teamId: "team-2", assignee: null, status: "todo", priority: "high", labels: ["ui"] });
    expect(moved.task.comments).toHaveLength(1);
    expect(moved.task.log[moved.task.log.length - 1]).toEqual({ at: 9_000, from: "lead", field: "transferred", was: "api", now: "web" });
    expect(moved.task.updated).toBe(9_000);
  });

  it("logs what the move reset — who held it, where it stood, what it waited on — before the move itself", () => {
    const done = task({ id: "task-2", status: "done" });
    const t = task({ id: "task-1", status: "in-progress", assignee: "impl-1", blockedBy: ["task-2"] });
    const moved = go(t, lead, [done]);
    expect(moved.ok && moved.task.log.slice(-4).map((e) => [e.field, e.was, e.now])).toEqual([
      ["assignee", "impl-1", null],
      ["status", "in-progress", "todo"],
      ["blockedBy", "task-2", null],
      ["transferred", "api", "web"],
    ]);
  });

  it("takes its id out of the closed tasks that named it, so none waits across teams if reopened", () => {
    const closed = task({ id: "task-3", status: "cancelled", blockedBy: ["task-1", "task-4"], updated: 5 });
    const other = task({ id: "task-4", status: "done" });
    const moved = go(task({ id: "task-1" }), lead, [closed, other]);
    if (!moved.ok) throw new Error("refused");
    const after = moved.board.tasks.find((x) => x.id === "task-3")!;
    expect(blockerIdsOf(after, moved.board)).toEqual(["task-4"]);
    expect(after.updated).toBe(5);
  });

  it("keeps a copy's links through the move — a fact crosses teams; only blocker links are dropped", () => {
    const source = task({ id: "task-1" });
    const copy = task({ id: "task-2" });
    const copyOfIt = task({ id: "task-3" });
    const b = board([source, copy, copyOfIt], 4, [relation("copied-from", "task-2", "task-1"), relation("copied-from", "task-3", "task-2")]);
    const moved = transferTask(copy, teams, lead, { board: b, roster: ROSTER, at: 9_000 });
    if (!moved.ok) throw new Error("refused");
    expect(moved.board.relations).toEqual(b.relations);
    expect(copiedFromOf(moved.task, moved.board)).toMatchObject({ id: "task-1" });
    expect(copiesOf(moved.task, moved.board).map((t) => t.id)).toEqual(["task-3"]);
  });

  it("leaves a blocker link whose other end is not on this board — not this board's to judge", () => {
    const b = board([task({ id: "task-1" })], 2, [relation("blocks", "task-9", "task-1")]);
    const moved = transferTask(b.tasks[0], teams, lead, { board: b, roster: ROSTER, at: 9_000 });
    expect(moved.ok && moved.board.relations).toEqual(b.relations);
  });

  it("keeps parked work parked", () => {
    const moved = go(task({ id: "task-1", status: "backlog" }), lead);
    expect(moved.ok && moved.task.status).toBe("backlog");
  });

  it("refuses a closed task, its own team, and an actor who does not hand out work", () => {
    expect(go(task({ id: "task-1", status: "done" }), lead)).toEqual({ ok: false, refusal: { kind: "transfer-closed", status: "done" } });
    const same = transferTask(task({ id: "task-1" }), { ...teams, to: teams.from }, lead, ctx([]));
    expect(same).toEqual({ ok: false, refusal: { kind: "transfer-same-team" } });
    expect(go(task({ id: "task-1", assignee: "impl-1" }), impl1)).toEqual({ ok: false, refusal: { kind: "not-yours-to-transfer" } });
    expect(go(task({ id: "task-1" }), USER_ACTOR).ok).toBe(true);
  });

  it("refuses while live blocker links tie it to its team — naming them — and drops the ones that hold nothing", () => {
    const blocker = task({ id: "task-2", status: "in-progress" });
    const dependant = task({ id: "task-3", blockedBy: ["task-1"] });
    expect(go(task({ id: "task-1", blockedBy: ["task-2"] }), lead, [blocker])).toEqual({
      ok: false,
      refusal: { kind: "transfer-linked", blockers: ["task-2"], dependants: [] },
    });
    expect(go(task({ id: "task-1" }), lead, [dependant])).toEqual({
      ok: false,
      refusal: { kind: "transfer-linked", blockers: [], dependants: ["task-3"] },
    });
    // A done blocker and a cancelled dependant hold nothing: it goes, the stale link left behind.
    const done = task({ id: "task-2", status: "done" });
    const closedDependant = task({ id: "task-3", status: "cancelled", blockedBy: ["task-1"] });
    const moved = go(task({ id: "task-1", blockedBy: ["task-2"] }), lead, [done, closedDependant]);
    if (!moved.ok) throw new Error("refused");
    expect(blockerIdsOf(moved.task, moved.board)).toEqual([]);
    // The closed dependant loses the link, logged at the transfer's time —
    // yet it was not touched by anyone, so its `updated` stays.
    const left = moved.board.tasks.find((t) => t.id === "task-3");
    expect(left && blockerIdsOf(left, moved.board)).toEqual([]);
    expect(moved.board.relations.filter((r) => r.kind === "blocks")).toEqual([]);
    expect(left?.log[left.log.length - 1]).toMatchObject({ at: 9_000, field: "blockedBy", was: "task-1", now: null });
    expect(left?.updated).toBe(closedDependant.updated);
  });
});
