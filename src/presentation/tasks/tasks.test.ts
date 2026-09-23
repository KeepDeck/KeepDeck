import { describe, expect, it } from "vitest";
import { board, task } from "../../domain/tasks/testSupport";
import { boardView } from "./boardView";
import { LADDER_WORDS, tasksLadder } from "./ladderView";
import { newTaskFormView } from "./newTaskFormView";
import { taskCardView, taskCardClassName } from "./taskCardView";
import { taskDetailView } from "./taskDetailView";
import { teamCardTasksLine } from "./teamCardTasksLine";
import { teamOnScreen } from "./teamOnScreen";
import { personName, priorityMark, statusTone } from "./words";

const NOW = 100_000;
const ROSTER = ["lead", "impl-1", "impl-2"];

describe("words", () => {
  it("names the person `you`, marks only the ends of the priority scale, and maps statuses onto the four hues", () => {
    expect(personName("user")).toBe("you");
    expect(personName("impl-1")).toBe("impl-1");
    expect([priorityMark("high"), priorityMark("normal"), priorityMark("low")]).toEqual(["HIGH", null, "LOW"]);
    expect(["in-progress", "review", "blocked", "done", "todo", "cancelled"].map((s) => statusTone(s as never))).toEqual([
      "working",
      "waiting",
      "failed",
      "done",
      "none",
      "none",
    ]);
  });
});

describe("taskCardClassName", () => {
  it("names the tone always, and each of cancelled, in flight and grabbable only when it holds", () => {
    const card = { tone: "working" as const, cancelled: false };
    expect(taskCardClassName(card, { dragging: false, grabbable: false })).toBe("tasks__card tasks__card--working");
    expect(taskCardClassName({ tone: "none", cancelled: true }, { dragging: true, grabbable: true })).toBe(
      "tasks__card tasks__card--none tasks__card--cancelled tasks__card--dragging tasks__card--grabbable",
    );
  });
});

describe("taskCardView", () => {
  it("reads id first, then the assignee or the pool, then the age; names open blockers only", () => {
    const b = board([
      task({ id: "task-1", status: "in-progress", assignee: "impl-1" }),
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
      cancelled: false,
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
    task({ id: "task-5", status: "cancelled" }),
  ]);

  it("lays the board out blocked-first, open columns in queue order, closed ones newest first — every column open, Cancelled included", () => {
    const columns = boardView(b.tasks, b, NOW);
    expect(columns.map((c) => `${c.status}:${c.count}`)).toEqual([
      "blocked:0",
      "todo:2",
      "in-progress:0",
      "review:0",
      "done:2",
      "cancelled:1",
    ]);
    expect(columns[1].cards.map((c) => c.id)).toEqual(["task-2", "task-1"]);
    // Done shows its cards: no column is folded away.
    expect(columns[4].cards.map((c) => c.id)).toEqual(["task-4", "task-3"]);
  });

  it("always shows Cancelled, its cards marked as taken off the board", () => {
    const columns = boardView(b.tasks, b, NOW);
    expect(columns.find((c) => c.status === "cancelled")?.cards[0].cancelled).toBe(true);
  });
});

describe("taskDetailView", () => {
  it("offers the person every status, in board order — they walk no ladder", () => {
    const b = board([task({ id: "task-1", assignee: "impl-1" })]);
    const view = taskDetailView(b.tasks[0], b, ROSTER, NOW);
    expect(view.status).toBe("todo");
    expect(view.statusOptions.map((o) => `${o.value}:${o.tone}`)).toEqual([
      "blocked:failed",
      "todo:none",
      "in-progress:working",
      "review:waiting",
      "done:done",
      "cancelled:none",
    ]);
  });

  it("blockers, what it unblocks, the thread and the log are worded", () => {
    const b = board([
      task({ id: "task-1", status: "in-progress", assignee: "impl-2" }),
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
    expect(view.meta).toBe("task-2 · by you · opened 1m ago · updated 1m ago");
    expect(view.blockers).toEqual([{ id: "task-1", text: "task-1 · in progress" }]);
    expect(view.blockersEmpty).toBeNull();
    expect(view.unblocks).toEqual([{ id: "task-3", title: "Task task-3" }]);
    expect(view.thread).toEqual([{ n: 1, who: "you", age: "1m ago", body: "go" }]);
    expect(view.log).toEqual([
      { who: "lead", text: "assignee: — → impl-1", age: "1h ago" },
      { who: "impl-1", text: "edited the brief (the previous version is kept in the log: 0 characters)", age: "1m ago" },
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

describe("taskDetailView — artifacts", () => {
  it("titles attached artifacts the registry knows, keeps unknown slugs, offers only what is not yet attached", () => {
    const b = board([task({ id: "task-1", artifacts: ["kd-tasks", "gone"] })]);
    const registry = [
      { id: "kd-tasks", title: "KeepDeck Tasks" },
      { id: "kd-tasks-ui", title: "UI prototypes" },
    ];
    const view = taskDetailView(b.tasks[0], b, ROSTER, NOW, registry);
    expect(view.artifacts).toEqual([
      { slug: "kd-tasks", title: "KeepDeck Tasks", known: true, openTitle: "Open in the browser", detachLabel: "Detach kd-tasks" },
      { slug: "gone", title: "gone", known: false, openTitle: "No longer published", detachLabel: "Detach gone" },
    ]);
    expect(view.attachOptions).toEqual([{ value: "kd-tasks-ui", label: "UI prototypes" }]);
    expect(view.attachEmpty).toBeNull();
    expect(taskDetailView(b.tasks[0], b, ROSTER, NOW, []).attachEmpty).toContain("Nothing published");
    expect(taskDetailView(b.tasks[0], b, ROSTER, NOW, [registry[0]]).attachEmpty).toContain("Every artifact");
  });
});

describe("teamOnScreen", () => {
  it("follows the focused task's team, then the choice, then the first", () => {
    const teams = ["team-1", "team-2"];
    expect(teamOnScreen(teams, null, null)).toBe("team-1");
    expect(teamOnScreen(teams, "team-2", null)).toBe("team-2");
    expect(teamOnScreen(teams, "team-1", "team-2")).toBe("team-2");
    expect(teamOnScreen(teams, "team-9", "team-9")).toBe("team-1");
    expect(teamOnScreen([], "team-1", null)).toBeNull();
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

describe("teamCardTasksLine", () => {
  it("counts what is open and what waits on a person; a finished board says done; an empty one says nothing", () => {
    expect(
      teamCardTasksLine([
        task({ id: "task-1" }),
        task({ id: "task-2", status: "in-progress" }),
        task({ id: "task-3", status: "blocked" }),
        task({ id: "task-4", status: "review" }),
        task({ id: "task-5", status: "review" }),
        task({ id: "task-6", status: "done" }),
      ]),
    ).toBe("2 open · 1 blocked · 2 in review");
    expect(teamCardTasksLine([task({ id: "task-1" })])).toBe("1 open");
    expect(teamCardTasksLine([task({ id: "task-1", status: "done" }), task({ id: "task-2", status: "cancelled" })])).toBe("1 done");
    expect(teamCardTasksLine([])).toBeNull();
  });
});

describe("ladder", () => {
  const ready = {
    kind: "ready" as const,
    board: board([task({ id: "task-1", status: "blocked" }), task({ id: "task-2", status: "review" }), task({ id: "task-3" })]),
    unsaved: null,
  };
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
});
