import { describe, expect, it } from "vitest";
import { board, task } from "../../domain/tasks/testSupport";
import { boardView } from "./boardView";
import { tasksDoorBadge } from "./doorBadge";
import { LADDER_WORDS, tasksLadder } from "./ladderView";
import { newTaskFormView } from "./newTaskFormView";
import { queuesView } from "./queuesView";
import { taskCardView } from "./taskCardView";
import { taskDetailView } from "./taskDetailView";
import { personName, priorityMark, statusTone } from "./words";

const NOW = 100_000;
const ROSTER = ["lead", "impl-1", "impl-2"];

describe("words", () => {
  it("names the person `you`, marks only the ends of the priority scale, and maps statuses onto the four hues", () => {
    expect(personName("user")).toBe("you");
    expect(personName("impl-1")).toBe("impl-1");
    expect([priorityMark("high"), priorityMark("normal"), priorityMark("low")]).toEqual(["HIGH", null, "LOW"]);
    expect(["doing", "review", "blocked", "done", "todo", "dropped"].map((s) => statusTone(s as never))).toEqual([
      "working",
      "waiting",
      "failed",
      "done",
      "none",
      "none",
    ]);
  });
});

describe("taskCardView", () => {
  it("reads id first, then the assignee or the pool, then the age; names open blockers only", () => {
    const b = board([
      task({ id: "task-1", status: "doing", assignee: "impl-1" }),
      task({ id: "task-2", status: "done" }),
      task({ id: "task-3", blockedBy: ["task-1", "task-2"], priority: "high", updated: NOW - 120_000 }),
    ]);
    expect(taskCardView(b.tasks[2], b, NOW)).toEqual({
      id: "task-3",
      title: "Task task-3",
      meta: "task-3 · pool · 2m ago",
      priority: "HIGH",
      blockedBy: "blocked by task-1",
      tone: "none",
      dropped: false,
    });
    expect(taskCardView(b.tasks[0], b, NOW).blockedBy).toBeNull();
  });
});

describe("boardView", () => {
  const b = board([
    task({ id: "task-1", status: "todo", priority: "low", created: 1 }),
    task({ id: "task-2", status: "todo", priority: "high", created: 2 }),
    task({ id: "task-3", status: "done", updated: 10 }),
    task({ id: "task-4", status: "done", updated: 20 }),
    task({ id: "task-5", status: "dropped" }),
  ]);

  it("lays the ladder out left to right, open columns in queue order, closed ones newest first and folded", () => {
    const columns = boardView(b.tasks, b, { showDropped: false, expanded: new Set(), now: NOW });
    expect(columns.map((c) => `${c.status}:${c.count}:${c.collapsed}`)).toEqual([
      "todo:2:false",
      "doing:0:false",
      "blocked:0:false",
      "review:0:false",
      "done:2:true",
    ]);
    expect(columns[0].cards.map((c) => c.id)).toEqual(["task-2", "task-1"]);
    expect(columns[4].cards.map((c) => c.id)).toEqual(["task-4", "task-3"]);
  });

  it("shows dropped only behind the filter, and unfolds what the person opened", () => {
    const columns = boardView(b.tasks, b, { showDropped: true, expanded: new Set(["done"] as const), now: NOW });
    expect(columns.map((c) => c.status)).toContain("dropped");
    expect(columns.find((c) => c.status === "done")?.collapsed).toBe(false);
    expect(columns.find((c) => c.status === "dropped")).toMatchObject({ collapsed: true, count: 1 });
    expect(columns.find((c) => c.status === "dropped")?.cards[0].dropped).toBe(true);
  });
});

describe("queuesView", () => {
  it("a lane per role — current, queue, why a queue is empty — then the pool", () => {
    const b = board([
      task({ id: "task-1", status: "doing", assignee: "impl-1" }),
      task({ id: "task-2", assignee: "impl-1", priority: "low" }),
      task({ id: "task-3", assignee: "impl-1", priority: "high" }),
      task({ id: "task-4", status: "review", assignee: "impl-2" }),
      task({ id: "task-5" }),
      task({ id: "task-6", teamId: "team-2" }),
    ]);
    const lanes = queuesView(b, "team-1", ROSTER, NOW);
    expect(lanes.map((l) => l.key)).toEqual(["lead", "impl-1", "impl-2", "pool"]);
    expect(lanes[0]).toMatchObject({ current: null, idleText: "Nothing in doing", queueEmptyText: "Nothing queued", summary: "0 queued" });
    expect(lanes[1].current?.id).toBe("task-1");
    expect(lanes[1].queued.map((c) => c.id)).toEqual(["task-3", "task-2"]);
    expect(lanes[1].summary).toBe("2 queued");
    expect(lanes[2]).toMatchObject({ idleText: "Nothing in doing", queueEmptyText: "Nothing queued — task-4 waits in review" });
    expect(lanes[3]).toMatchObject({ isPool: true, summary: "1 queued · unassigned", queueEmptyText: null });
    expect(lanes[3].queued.map((c) => c.id)).toEqual(["task-5"]);
  });
});

describe("taskDetailView", () => {
  it("offers exactly the moves the person may make, from the transition table", () => {
    const b = board([task({ id: "task-1", assignee: "impl-1" })]);
    const fromTodo = taskDetailView(b.tasks[0], b, ROSTER, NOW);
    expect(fromTodo.moves).toEqual([
      { to: "doing", label: "Start — doing", primary: true },
      { to: "dropped", label: "Drop", primary: false },
    ]);
    const inReview = board([task({ id: "task-1", status: "review", assignee: "impl-1" })]);
    expect(taskDetailView(inReview.tasks[0], inReview, ROSTER, NOW).moves.map((m) => m.label)).toEqual([
      "Return — to doing",
      "Accept",
      "Drop",
    ]);
    const done = board([task({ id: "task-1", status: "done" })]);
    expect(taskDetailView(done.tasks[0], done, ROSTER, NOW).moves.map((m) => m.label)).toEqual(["Reopen"]);
  });

  it("a blocked start is not offered; blockers, what it unblocks, the thread and the log are worded", () => {
    const b = board([
      task({ id: "task-1", status: "doing", assignee: "impl-2" }),
      task({
        id: "task-2",
        author: "user",
        blockedBy: ["task-1"],
        comments: [{ n: 1, at: NOW - 60_000, from: "user", body: "go" }],
        log: [
          { at: NOW - 3_600_000, from: "lead", field: "assignee", was: null, now: "impl-1" },
          { at: NOW - 60_000, from: "impl-1", field: "body", was: null, now: null },
        ],
      }),
      task({ id: "task-3", blockedBy: ["task-2"] }),
    ]);
    const view = taskDetailView(b.tasks[1], b, ROSTER, NOW);
    expect(view.moves.map((m) => m.to)).toEqual(["dropped"]);
    expect(view.meta).toBe("task-2 · by you · opened 1m ago · updated 1m ago");
    expect(view.blockers).toEqual([{ id: "task-1", text: "task-1 · doing" }]);
    expect(view.blockersEmpty).toBeNull();
    expect(view.unblocks).toEqual([{ id: "task-3", title: "Task task-3" }]);
    expect(view.thread).toEqual([{ n: 1, who: "you", age: "1m ago", body: "go" }]);
    expect(view.log).toEqual([
      { who: "lead", text: "assignee: — → impl-1", age: "1h ago" },
      { who: "impl-1", text: "edited the brief", age: "1m ago" },
    ]);
    expect(view.assigneeOptions.map((o) => o.value)).toEqual(["", "lead", "impl-1", "impl-2"]);
  });

  it("a todo task with no blockers says it can start now; an off-roster assignee stays choosable", () => {
    const b = board([task({ id: "task-1", assignee: "tester-1" })]);
    const view = taskDetailView(b.tasks[0], b, ROSTER, NOW);
    expect(view.blockersEmpty).toBe("none — can start now");
    expect(view.assigneeOptions.map((o) => o.value)).toContain("tester-1");
    expect(view.bodyEmpty).toBe("No brief — the title is all there is");
  });
});

describe("newTaskFormView", () => {
  it("offers the pool first, then the roster, and says which addresses teammates use", () => {
    const view = newTaskFormView(ROSTER);
    expect(view.assigneeOptions.map((o) => o.value)).toEqual(["", "lead", "impl-1", "impl-2"]);
    expect(view.addressHint).toContain("lead · impl-1 · impl-2");
    expect(newTaskFormView([]).addressHint).toContain("pool");
  });
});

describe("ladder and badge", () => {
  const ready = { kind: "ready" as const, board: board([task({ id: "task-1", status: "blocked" }), task({ id: "task-2", status: "review" }), task({ id: "task-3" })]) };
  const base = { workspaceId: "ws-1", hasTeam: true, ownerUp: true, enableRefusal: null, state: ready, taskCount: 3 };

  it("classifies in order: no workspace, owner down (refusal or loading), no team, loading, unreadable, empty, board", () => {
    expect(tasksLadder({ ...base, workspaceId: null })).toEqual({ kind: "noWorkspace" });
    expect(tasksLadder({ ...base, ownerUp: false })).toEqual({ kind: "loading" });
    expect(tasksLadder({ ...base, ownerUp: false, enableRefusal: "task board is owned by another KeepDeck process" })).toEqual({
      kind: "refusal",
      message: "task board is owned by another KeepDeck process",
    });
    expect(tasksLadder({ ...base, hasTeam: false })).toEqual({ kind: "noTeam" });
    expect(tasksLadder({ ...base, state: { kind: "loading" } })).toEqual({ kind: "loading" });
    expect(tasksLadder({ ...base, state: { kind: "unreadable", error: "board.json is not JSON" } })).toEqual({ kind: "refusal", message: "board.json is not JSON" });
    expect(tasksLadder({ ...base, taskCount: 0 })).toEqual({ kind: "empty" });
    expect(tasksLadder(base)).toEqual({ kind: "board" });
    expect(LADDER_WORDS.empty.hint).toContain("agents read the board themselves");
  });

  it("the door counts what waits on a person, and nothing while the board is not ready", () => {
    expect(tasksDoorBadge(ready)).toBe(2);
    expect(tasksDoorBadge({ kind: "loading" })).toBe(0);
    expect(tasksDoorBadge(null)).toBe(0);
  });
});
