import { describe, expect, it } from "vitest";
import { TASK_CAPS } from "../../domain/tasks";
import { board, task } from "../../domain/tasks/testSupport";
import { boardView, columnLabelClassName } from "./boardView";
import { NO_QUERY } from "./queryView";
import { LADDER_WORDS, tasksLadder } from "./ladderView";
import { newTaskFormView, NEW_TASK_WORDS } from "./newTaskFormView";
import { roleInitials, statusMark, statusRing, taskCardView, taskCardClassName } from "./taskCardView";
import { TASK_DETAIL_WORDS, feedOf, pickedArtifact, pickedStatus, taskDetailClassName, taskDetailView } from "./taskDetailView";
import { teamCardTasksLine } from "./teamCardTasksLine";
import { teamOnScreen } from "./teamOnScreen";
import { personName, priorityMark, statusTone, FIELD_WORDS, POOL_CHOICE } from "./words";

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
    expect(taskCardView(b.tasks[2], b, NOW)).toMatchObject({
      id: "task-3",
      title: "Task task-3",
      meta: "task-3 · pool · 2m ago",
      priority: "HIGH",
      blockedBy: "blocked by task-1",
      tone: "none",
      cancelled: false,
      labels: [],
      assignee: "pool",
      initials: null,
      age: "2m ago",
      ring: { fill: 0, tone: "none", barred: false, label: "To do" },
    });
    // Every blocker as a chip, a resolved one struck.
    expect(taskCardView(b.tasks[2], b, NOW).blockerChips.map((c) => [c.id, c.resolved])).toEqual([
      ["task-1", false],
      ["task-2", true],
    ]);
    expect(taskCardView(b.tasks[0], b, NOW).blockedBy).toBeNull();
    expect(taskCardView({ ...b.tasks[0], labels: ["ui"] }, b, NOW).labels).toEqual(["ui"]);
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
    const columns = boardView(b.tasks, b, NOW, NO_QUERY);
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
    const columns = boardView(b.tasks, b, NOW, NO_QUERY);
    expect(columns.find((c) => c.status === "cancelled")?.cards[0].cancelled).toBe(true);
  });
});

describe("task panel and form words and classes", () => {
  it("names the panel after its task and widens only when it fills the stage", () => {
    expect(TASK_DETAIL_WORDS.panel("task-4")).toBe("Task task-4");
    expect(taskDetailClassName(false)).toBe("tasks__detail");
    expect(taskDetailClassName(true)).toBe("tasks__detail tasks__detail--wide");
  });

  it("the form and the panel share one pool line and one set of field names", () => {
    const b = board([task({ id: "task-1", artifacts: ["kd-a"] })]);
    const detail = taskDetailView(b.tasks[0], b, ["lead"], NOW, [{ id: "kd-a", title: "A" }]);
    expect(newTaskFormView(["lead"]).assigneeOptions[0]).toBe(POOL_CHOICE);
    // The same words, with the pool's mark beside them.
    expect(detail.assigneeOptions[0]).toEqual({ ...POOL_CHOICE, initials: null });
    expect(FIELD_WORDS).toEqual({ title: "Title", brief: "Brief", status: "Status", priority: "Priority", assignee: "Assignee" });
    // The detach tooltip and its accessible label say the same word.
    expect(detail.artifacts[0].detachLabel).toBe(`${TASK_DETAIL_WORDS.detach} kd-a`);
    // Beside its word, the ring is a picture only — the word names it.
    expect(detail.statusOptions[0].ring).toEqual({ ...statusRing(detail.statusOptions[0].value), decorative: true });
  });

  it("a pick asks for nothing when it changes nothing", () => {
    expect(pickedStatus("todo", "todo")).toBeNull();
    expect(pickedStatus("todo", "in-progress")).toBe("in-progress");
    expect(pickedArtifact("")).toBeNull();
    expect(pickedArtifact("kd-a")).toBe("kd-a");
  });

  it("names the form's own buttons", () => {
    expect([NEW_TASK_WORDS.panel, NEW_TASK_WORDS.cancel, NEW_TASK_WORDS.create]).toEqual(["New task", "Cancel", "Create task"]);
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
    expect(view.meta).toBe("task-2 · To do · by you · updated 1m ago");
    expect(view.statusRing).toEqual(statusMark("todo"));
    expect(statusMark("todo")).toEqual({ ...statusRing("todo"), decorative: true });
    expect(view.blockers).toEqual([
      { id: "task-1", text: "task-1 · in progress", resolved: false, className: "kd-tag kd-tag--outline tasks__tag--blocking" },
    ]);
    expect(view.blockersEmpty).toBeNull();
    expect(view.unblocks).toEqual([{ id: "task-3", title: "Task task-3" }]);
    expect(view.feed.map(({ key: _key, ...rest }) => rest)).toEqual([
      { kind: "change", who: "lead", text: "assignee: — → impl-1", age: "1h ago" },
      { kind: "change", who: "impl-1", text: "edited the brief (the previous version is kept in the log: 0 characters)", age: "1m ago" },
      { kind: "comment", who: "you", age: "1m ago", body: "go" },
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
    expect(taskDetailView(b.tasks[0], b, ROSTER, NOW, []).attachEmpty?.title).toContain("Nothing published");
    expect(taskDetailView(b.tasks[0], b, ROSTER, NOW, []).attachEmpty?.text).toBe("none");
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

describe("columnLabelClassName", () => {
  it("dresses a column's label in its status's hue", () => {
    expect(columnLabelClassName("in-progress")).toBe("tasks__column-label tasks__column-label--in-progress");
  });
});

describe("taskDetailView — labels", () => {
  it("lists the task's labels, offers the team's others, and says when no more fit", () => {
    const b = board([
      task({ id: "task-1", labels: ["ui"] }),
      task({ id: "task-2", labels: ["ui", "bell"] }),
      task({ id: "task-3", teamId: "team-2", labels: ["elsewhere"] }),
    ]);
    const view = taskDetailView(b.tasks[0], b, [], 0);
    expect(view.labels).toEqual([{ label: "ui", removeLabel: "Remove ui" }]);
    // Another team's words are not this board's vocabulary.
    expect(view.labelOptions).toEqual(["bell"]);
    expect(view.labelsFull).toBeNull();
    const full = task({ id: "task-4", labels: ["a", "b", "c", "d", "e"] });
    expect(taskDetailView(full, board([full]), [], 0).labelsFull).toBe(TASK_DETAIL_WORDS.labelsFull(5));
  });
});

describe("feedOf — a task's history as one timeline", () => {
  const change = (at: number, now: string) => ({ at, from: "lead", field: "status" as const, was: null, now });
  const comment = (n: number, at: number) => ({ n, at, from: "impl-1", body: `c${n}` });
  const shape = (task: Parameters<typeof feedOf>[0]) =>
    feedOf(task, 10_000).map((item) =>
      item.kind === "comment" ? item.body : item.kind === "change" ? item.text : `[${item.label}: ${item.changes.map((c) => c.text).join(", ")}]`,
    );

  it("interleaves what was said and what was changed, oldest first — a change before the comment that came with it", () => {
    expect(shape({ log: [change(1, "a"), change(3, "b")], comments: [comment(1, 2), comment(2, 3)] })).toEqual([
      "status: — → a",
      "c1",
      "status: — → b",
      "c2",
    ]);
  });

  it("folds a run to its first and last once two or more would hide", () => {
    const log = [1, 2, 3, 4, 5].map((at) => change(at, `s${at}`));
    expect(shape({ log, comments: [] })).toEqual([
      "status: — → s1",
      "[3 more changes: status: — → s2, status: — → s3, status: — → s4]",
      "status: — → s5",
    ]);
    // Three in a row: a fold would hide one line behind one line — no fold.
    expect(shape({ log: log.slice(0, 3), comments: [] })).toEqual(["status: — → s1", "status: — → s2", "status: — → s3"]);
    expect(shape({ log: log.slice(0, 4), comments: [] })).toEqual([
      "status: — → s1",
      "[2 more changes: status: — → s2, status: — → s3]",
      "status: — → s4",
    ]);
  });

  it("leaves two changes in a row alone, and lets a comment break a run", () => {
    expect(shape({ log: [change(1, "a"), change(2, "b")], comments: [] })).toEqual(["status: — → a", "status: — → b"]);
    expect(shape({ log: [change(1, "a"), change(2, "b"), change(4, "c"), change(5, "d")], comments: [comment(1, 3)] })).toEqual([
      "status: — → a",
      "status: — → b",
      "c1",
      "status: — → c",
      "status: — → d",
    ]);
  });

  it("keys every item uniquely — a folded run's included", () => {
    const log = [1, 2, 3, 4].map((at) => change(at, `s${at}`));
    const feed = feedOf({ log, comments: [comment(1, 5)] }, 0);
    const keys = feed.flatMap((item) => (item.kind === "more" ? [item.key, ...item.changes.map((c) => c.key)] : [item.key]));
    expect(new Set(keys).size).toBe(keys.length);
    // Twins — the same moment, the same field — still key apart.
    const twins = feedOf({ log: [change(1, "a"), change(1, "b")], comments: [] }, 0);
    expect(new Set(twins.map((item) => item.key)).size).toBe(2);
  });

  it("keeps a change's key as the log is cut from the front at its cap", () => {
    const log = [1, 2, 3, 4, 5].map((at) => change(at, `s${at}`));
    const keyOf = (feed: ReturnType<typeof feedOf>, text: string) =>
      feed.flatMap((item) => (item.kind === "more" ? item.changes : [item])).find((item) => "text" in item && item.text === text)?.key;
    const before = feedOf({ log, comments: [] }, 0);
    const after = feedOf({ log: [...log.slice(1), change(6, "s6")], comments: [] }, 0);
    expect(keyOf(after, "status: — → s3")).toBe(keyOf(before, "status: — → s3"));
  });

  it("says when older history was trimmed — either cap, each on its own", () => {
    const b = board([task({ id: "task-1" })]);
    const full = (over: Partial<ReturnType<typeof task>>) => taskDetailView(task({ id: "task-1", ...over }), b, ROSTER, 0).feedTrimmed;
    expect(full({})).toBeNull();
    expect(full({ log: Array.from({ length: TASK_CAPS.logMax }, (_, i) => change(i, "x")) })).toBe(
      TASK_DETAIL_WORDS.feedTrimmed(TASK_CAPS.logMax, TASK_CAPS.commentsMax),
    );
    expect(full({ comments: Array.from({ length: TASK_CAPS.commentsMax }, (_, i) => comment(i + 1, i)) })).not.toBeNull();
  });
});

describe("roleInitials", () => {
  it("is a role's kind and number, or its first two letters; none for the pool", () => {
    expect(roleInitials("analyst-2")).toBe("A2");
    expect(roleInitials("reviewer-12")).toBe("R12");
    expect(roleInitials("lead")).toBe("LE");
    expect(roleInitials(null)).toBeNull();
  });
});

describe("statusRing — a task's place on the ladder as a ring", () => {
  it("fills by the rung, in the status's hue; blocked is barred, cancelled a grey disc", () => {
    expect(statusRing("todo")).toEqual({ fill: 0, tone: "none", barred: false, label: "To do" });
    expect(statusRing("in-progress")).toMatchObject({ fill: 50, tone: "working", barred: false });
    expect(statusRing("review")).toMatchObject({ fill: 75, tone: "waiting" });
    expect(statusRing("done")).toMatchObject({ fill: 100, tone: "done" });
    expect(statusRing("blocked")).toMatchObject({ fill: 0, tone: "failed", barred: true });
    expect(statusRing("cancelled")).toMatchObject({ fill: 100, tone: "none", barred: false });
  });
});
