import { describe, expect, it } from "vitest";
import { TASK_CAPS, USER_ACTOR, type TaskActor, type TaskStatus } from "./model";
import { attachArtifact, createTask, detachArtifact, reachableStatuses, transition, type TaskChange, type TaskRefusal } from "./transition";
import { ROSTER, board, impl1, lead, noTeam, peer1, stranger, task } from "./testSupport";

const ctx = (tasks = [task({ id: "task-1" })]) => ({ board: board(tasks), roster: ROSTER, at: 5_000 });

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

  it("reserves acceptance, return, reopening and cancelling for whoever hands out work", () => {
    const inReview = task({ id: "task-1", status: "review", assignee: "impl-1" });
    expect(refusalOf(inReview, { kind: "status", to: "done" }, impl1)).toEqual({ kind: "review-not-yours" });
    expect(refusalOf(inReview, { kind: "status", to: "in-progress" }, impl1)).toEqual({ kind: "review-not-yours" });
    expect(moved(inReview, "done", lead).status).toBe("done");
    expect(moved(inReview, "in-progress", peer1).status).toBe("in-progress");
    expect(moved(inReview, "done", USER_ACTOR).status).toBe("done");

    const done = task({ id: "task-1", status: "done" });
    expect(refusalOf(done, { kind: "status", to: "todo" }, impl1)).toEqual({ kind: "review-not-yours" });
    expect(moved(done, "todo", lead).status).toBe("todo");

    const inProgress = task({ id: "task-1", status: "in-progress", assignee: "impl-1" });
    expect(refusalOf(inProgress, { kind: "status", to: "cancelled" }, impl1)).toEqual({ kind: "review-not-yours" });
    expect(moved(inProgress, "cancelled", lead).status).toBe("cancelled");
  });

  it("refuses every edge the table does not name, and treats no-move as no-op", () => {
    const cases: [TaskStatus, TaskStatus][] = [
      ["todo", "review"],
      ["todo", "done"],
      ["in-progress", "done"],
      ["blocked", "review"],
      ["done", "in-progress"],
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
      reachable: ["in-progress", "cancelled"],
    });
    // A working role may not cancel: only the start is its to make.
    expect(refusalOf(t, { kind: "status", to: "done" }, impl1, ctx([t]))).toMatchObject({
      reachable: ["in-progress"],
    });
    // An open blocker takes the start away; what is left is still said.
    const blocker = task({ id: "task-1" });
    const held = task({ id: "task-2", assignee: "impl-1", blockedBy: ["task-1"] });
    expect(refusalOf(held, { kind: "status", to: "done" }, impl1, ctx([blocker, held]))).toMatchObject({
      reachable: [],
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
    expect(reachableStatuses(t, USER_ACTOR, c)).toEqual(["in-progress", "blocked", "review", "done", "cancelled"]);
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
});

describe("reachableStatuses", () => {
  it("lists, in ladder order, exactly the rungs the actor may move to", () => {
    const t = task({ id: "task-1", assignee: "impl-1" });
    expect(reachableStatuses(t, impl1, ctx([t]))).toEqual(["in-progress"]);
    expect(reachableStatuses(t, lead, ctx([t]))).toEqual(["in-progress", "cancelled"]);
    const inReview = task({ id: "task-1", status: "review", assignee: "impl-1" });
    expect(reachableStatuses(inReview, lead, ctx([inReview]))).toEqual(["in-progress", "done", "cancelled"]);
    expect(reachableStatuses(inReview, impl1, ctx([inReview]))).toEqual([]);
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
    });
    expect(refusalOf(t, { kind: "body", to: "x".repeat(TASK_CAPS.bodyMax + 1) }, lead)).toEqual({
      kind: "field-cap",
      field: "body",
      max: TASK_CAPS.bodyMax,
    });
    expect(refusalOf(t, { kind: "comment", body: " " }, impl1)).toEqual({ kind: "blank", field: "comment" });
    expect(refusalOf(t, { kind: "comment", body: "x".repeat(TASK_CAPS.commentMax + 1) }, impl1)).toEqual({
      kind: "field-cap",
      field: "comment",
      max: TASK_CAPS.commentMax,
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
});

describe("what every member may do", () => {
  it("comments get monotone ordinals that survive eviction of the oldest", () => {
    let t = task({ id: "task-1", assignee: "impl-2" });
    for (let i = 0; i < TASK_CAPS.commentsMax + 2; i += 1) {
      const result = transition(t, { kind: "comment", body: `note ${i}` }, impl1, ctx([t]));
      if (!result.ok) throw new Error("refused");
      t = result.task;
    }
    expect(t.comments).toHaveLength(TASK_CAPS.commentsMax);
    expect(t.comments[0].n).toBe(3);
    expect(t.comments[t.comments.length - 1].n).toBe(TASK_CAPS.commentsMax + 2);
    expect(t.comments[t.comments.length - 1]).toMatchObject({ from: "impl-1", body: `note ${TASK_CAPS.commentsMax + 1}` });
  });

  it("any member attaches artifacts; the user signs as `user`", () => {
    const t = task({ id: "task-1", assignee: "impl-2" });
    const byPeer = transition(t, { kind: "artifacts", to: ["kd-tasks", "", "kd-tasks"] }, impl1, ctx([t]));
    expect(byPeer.ok && byPeer.task.artifacts).toEqual(["kd-tasks"]);
    const byUser = transition(t, { kind: "comment", body: "looks right" }, USER_ACTOR, ctx([t]));
    expect(byUser.ok && byUser.task.comments[0].from).toBe("user");
  });

  it("a brief edit keeps the previous brief in the log, whole, once", () => {
    const t = task({ id: "task-1", assignee: "lead", body: "first" });
    const once = transition(t, { kind: "body", to: "second" }, lead, ctx([t]));
    if (!once.ok) throw new Error("refused");
    expect(once.task.body).toBe("second");
    expect(once.task.log).toEqual([{ at: 5_000, from: "lead", field: "body", was: "first", now: null }]);
    const twice = transition(once.task, { kind: "body", to: "third" }, lead, ctx([once.task]));
    expect(twice.ok && twice.task.log.map((e) => e.was)).toEqual(["first", "second"]);
  });

  it("the log is bounded, oldest first to go", () => {
    let t = task({ id: "task-1", assignee: "lead" });
    for (let i = 0; i < TASK_CAPS.logMax + 5; i += 1) {
      const result = transition(t, { kind: "priority", to: i % 2 ? "high" : "low" }, lead, ctx([t]));
      if (!result.ok) throw new Error("refused");
      t = result.task;
    }
    expect(t.log).toHaveLength(TASK_CAPS.logMax);
  });
});

describe("createTask", () => {
  const empty = { board: board([]), roster: ROSTER, at: 7_000 };

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

  it("checks team, roster, blockers and the board cap", () => {
    const foreign = createTask({ teamId: "team-1", title: "x" }, stranger, empty);
    expect(!foreign.ok && foreign.refusal).toEqual({ kind: "not-on-team" });
    const ghost = createTask({ teamId: "team-1", title: "x", assignee: "ghost" }, lead, empty);
    expect(!ghost.ok && ghost.refusal).toEqual({ kind: "assignee-not-on-team", assignee: "ghost" });
    const unknown = createTask({ teamId: "team-1", title: "x", blockedBy: ["task-4"] }, lead, empty);
    expect(!unknown.ok && unknown.refusal).toEqual({ kind: "unknown-blocker", ids: ["task-4"] });
    const full = {
      ...empty,
      board: board(Array.from({ length: TASK_CAPS.tasksMax }, (_, i) => task({ id: `task-${i + 1}` }))),
    };
    const refused = createTask({ teamId: "team-1", title: "x" }, lead, full);
    expect(!refused.ok && refused.refusal).toEqual({ kind: "board-full", max: TASK_CAPS.tasksMax });
    const edge = { ...empty, board: { nextId: Number.MAX_SAFE_INTEGER, tasks: [] } };
    const exhausted = createTask({ teamId: "team-1", title: "x" }, lead, edge);
    expect(!exhausted.ok && exhausted.refusal).toEqual({ kind: "counter-exhausted" });
  });
});

describe("attachArtifact / detachArtifact", () => {
  const t = task({ id: "task-1", artifacts: ["kd-a", "kd-b"] });

  it("attaches a slug once — a second attach changes nothing", () => {
    expect(attachArtifact(t, "kd-c")).toEqual({ kind: "artifacts", to: ["kd-a", "kd-b", "kd-c"] });
    expect(attachArtifact(t, "kd-a")).toEqual({ kind: "artifacts", to: ["kd-a", "kd-b"] });
  });

  it("detaches only the slug named, and a slug not attached leaves the list as it is", () => {
    expect(detachArtifact(t, "kd-a")).toEqual({ kind: "artifacts", to: ["kd-b"] });
    expect(detachArtifact(t, "kd-z")).toEqual({ kind: "artifacts", to: ["kd-a", "kd-b"] });
  });
});
