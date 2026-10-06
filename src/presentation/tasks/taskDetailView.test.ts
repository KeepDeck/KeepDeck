import { describe, expect, it } from "vitest";
import { board, relation, task } from "../../domain/tasks/testSupport";
import { newTaskFormView, NEW_TASK_WORDS } from "./newTaskFormView";
import { statusMark, statusRing } from "./taskRowView";
import { TASK_DETAIL_WORDS, changesOf, pickedPriority, commentsOf, menuActionDisabled, renamedTitle, pickedStatus, taskDetailClassName, taskDetailView } from "./taskDetailView";
import { FIELD_WORDS, POOL_CHOICE } from "./words";

const NOW = 100_000;
const ROSTER = ["lead", "impl-1", "impl-2"];

describe("task panel and form words and classes", () => {
  it("names the panel after its task and widens only when it fills the stage", () => {
    expect(TASK_DETAIL_WORDS.panel("task-4")).toBe("Task task-4");
    expect(taskDetailClassName(false)).toBe("tasks__detail");
    expect(taskDetailClassName(true)).toBe("tasks__detail tasks__detail--wide");
  });

  it("the form and the panel share one pool line and one set of field names", () => {
    const b = board([task({ id: "task-1", artifacts: ["kd-a"] })]);
    const detail = taskDetailView(b.tasks[0], b, ["lead"], NOW, [{ id: "kd-a", title: "A" }]);
    expect(newTaskFormView(["lead"], null, null, null).assigneeOptions[0]).toBe(POOL_CHOICE);
    // The same words, with the pool's mark beside them.
    expect(detail.assigneeOptions[0]).toEqual(POOL_CHOICE);
    expect(FIELD_WORDS).toEqual({ title: "Title", brief: "Brief", status: "Status", priority: "Priority", assignee: "Assignee", kind: "Type", epic: "Epic" });
    // The detach tooltip and its accessible label say the same word.
    expect(detail.artifacts[0].detachLabel).toBe(`${TASK_DETAIL_WORDS.detach} kd-a`);
    // Beside its word, the ring is a picture only — the word names it.
    expect(detail.statusOptions[0].ring).toEqual({ ...statusRing(detail.statusOptions[0].value), decorative: true });
  });

  it("a pick asks for nothing when it changes nothing", () => {
    expect(pickedStatus("todo", "todo")).toBeNull();
    expect(pickedStatus("todo", "in-progress")).toBe("in-progress");
    expect(pickedPriority("normal", "normal")).toBeNull();
    expect(pickedPriority("normal", "high")).toBe("high");
    // No priority at all asks for nothing either.
    expect(pickedPriority("normal", "urgent")).toBeNull();
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
      "backlog:none",
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
          { at: NOW - 60_000, from: "impl-1", field: "body", was: "1", now: "2" },
        ],
      }),
      task({ id: "task-3", blockedBy: ["task-2"] }),
    ]);
    const view = taskDetailView(b.tasks[1], b, ROSTER, NOW);
    expect(view.meta).toBe("task-2 · To do · by you · updated 1m ago");
    expect(view.statusRing).toEqual(statusMark("todo"));
    expect(statusMark("todo")).toEqual({ ...statusRing("todo"), decorative: true });
    expect(view.blockers).toEqual([
      {
        id: "task-1",
        text: "task-1 · in progress",
        resolved: false,
        className: "kd-tag kd-tag--outline tasks__tag--blocking",
        removeLabel: "Stop waiting on task-1",
      },
    ]);
    expect(view.blockersEmpty).toBeNull();
    expect(view.unblocks).toEqual([{ id: "task-3", title: "Task task-3" }]);
    expect(view.changes.map(({ key: _key, ...rest }) => rest)).toEqual([
      { kind: "change", who: "lead", text: "assignee: — → impl-1", age: "1h ago" },
      { kind: "change", who: "impl-1", text: "edited the brief (v1 → v2)", age: "1m ago" },
    ]);
    expect(view.comments.map(({ key: _key, ...rest }) => rest)).toEqual([{ who: "you", age: "1m ago", body: "go" }]);
    expect(view.assigneeOptions.map((o) => o.value)).toEqual(["", "lead", "impl-1", "impl-2"]);
  });

  it("says a first build's brief edit, which kept no text, was made — and that its earlier text was not kept", () => {
    const b = board([task({ id: "task-1", log: [{ at: NOW - 60_000, from: "lead", field: "body", was: null, now: null }] })]);
    expect(taskDetailView(b.tasks[0], b, ROSTER, NOW).changes.map((c) => c.text)).toEqual(["edited the brief (its earlier text was not kept)"]);
  });

  it("a todo task with no blockers says it can start now; an off-roster assignee stays choosable", () => {
    const b = board([task({ id: "task-1", assignee: "tester-1" })]);
    const view = taskDetailView(b.tasks[0], b, ROSTER, NOW);
    expect(view.blockersEmpty).toBe("none — can start now");
    expect(view.assigneeOptions.map((o) => o.value)).toContain("tester-1");
    expect(view.bodyEmpty).toBe("No brief — the title is all there is");
  });
});

describe("taskDetailView — an epic and its tasks", () => {
  const family = () =>
    board(
      [
        task({ id: "task-1", kind: "epic", status: "review", title: "Plan" }),
        task({ id: "task-2", status: "todo", title: "Schema", assignee: "impl-1" }),
        task({ id: "task-3", status: "cancelled", title: "Old" }),
        task({ id: "task-4", title: "Loose" }),
        task({ id: "task-5", kind: "epic", title: "Other" }),
      ],
      6,
      [relation("child-of", "task-2", "task-1"), relation("child-of", "task-3", "task-1")],
    );

  it("an epic's card: its chip, its tasks and progress, the adds — and no epic of its own", () => {
    const b = family();
    const view = taskDetailView(b.tasks[0], b, ROSTER, NOW);
    expect(view.kindChip).toBe("EPIC");
    expect(view.parent).toBeNull();
    expect(view.epic).toMatchObject({
      heading: "Tasks of the epic",
      progress: { count: "0/1", fill: 0, summary: "0 of 1 done" },
      empty: null,
      addNew: "New task in the epic",
      addExisting: "Add an existing task",
    });
    expect(view.epic?.tasks.map((t) => [t.id, t.assignee, t.className])).toEqual([
      ["task-2", "impl-1", "tasks__epic-task tasks__epic-task--todo"],
      ["task-3", "unassigned", "tasks__epic-task tasks__epic-task--cancelled"],
    ]);
    // Only work under no epic may be added — not an epic, not its own.
    expect(view.palette("epic-task").sections[0].items.map((item) => item.value)).toEqual(["task-4"]);
  });

  it("offers to add no task the epic already waits on — the family rule whole, its loop check included", () => {
    const b = board([task({ id: "task-1", kind: "epic" }), task({ id: "task-2", blockedBy: ["task-1"] }), task({ id: "task-3" })], 4);
    const view = taskDetailView(b.tasks[0], b, ROSTER, NOW);
    expect(view.palette("epic-task").sections[0].items.map((item) => item.value)).toEqual(["task-3"]);
    const waiting = board([b.tasks[0], b.tasks[1]], 3, b.relations);
    expect(taskDetailView(waiting.tasks[0], waiting, ROSTER, NOW).epic?.addExisting).toBeNull();
  });

  it("an epic with no tasks says so; with no task left to add, it offers no Add an existing task", () => {
    const lone = board([task({ id: "task-1", kind: "epic" })], 2);
    const view = taskDetailView(lone.tasks[0], lone, ROSTER, NOW).epic!;
    expect(view.empty).toBe("No tasks under it yet");
    expect(view.tasks).toEqual([]);
    expect(view.addExisting).toBeNull();
    expect(view.addNew).toBe("New task in the epic");
    // Tasks under it: nothing empty to say.
    const b = family();
    expect(taskDetailView(b.tasks[0], b, ROSTER, NOW).epic?.empty).toBeNull();
  });

  it("a closed epic offers no new task in it — it takes no open work", () => {
    const b = board([task({ id: "task-1", kind: "epic", status: "done" })], 2);
    expect(taskDetailView(b.tasks[0], b, ROSTER, NOW).epic?.addNew).toBeNull();
    const open = board([task({ id: "task-1", kind: "epic" })], 2);
    expect(taskDetailView(open.tasks[0], open, ROSTER, NOW).epic?.addNew).toBe("New task in the epic");
  });

  it("shows Done and Cancelled refused while work is open, the picker saying which", () => {
    const b = family();
    const view = taskDetailView(b.tasks[0], b, ROSTER, NOW);
    const option = (value: string) => view.statusOptions.find((o) => o.value === value);
    expect([option("done")?.disabled, option("cancelled")?.disabled, option("todo")?.disabled]).toEqual([true, true, false]);
    expect(view.statusNote).toBe("Done and Cancelled wait for the epic's tasks: task-2 (to do)");
    // Work closed: nothing refused, nothing said.
    const closed = board(b.tasks.map((t) => (t.id === "task-2" ? { ...t, status: "done" as const } : t)), 6, b.relations);
    const free = taskDetailView(closed.tasks[0], closed, ROSTER, NOW);
    expect(free.statusOptions.every((o) => !o.disabled)).toBe(true);
    expect(free.statusNote).toBeNull();
  });

  it("refuses reopening a task under a closed epic, saying to reopen the epic", () => {
    const b = board([task({ id: "task-1", kind: "epic", status: "done" }), task({ id: "task-2", status: "done" })], 3, [relation("child-of", "task-2", "task-1")]);
    const view = taskDetailView(b.tasks[1], b, ROSTER, NOW);
    expect(view.statusOptions.filter((o) => o.disabled).map((o) => o.value)).toEqual(["blocked", "backlog", "todo", "in-progress", "review"]);
    expect(view.statusNote).toBe("The epic task-1 is closed — reopen it first");
  });

  it("work's Epic picker: none, the epic it is under, and the ones it could go under", () => {
    const b = family();
    expect(taskDetailView(b.tasks[1], b, ROSTER, NOW).parent).toEqual({
      value: "task-1",
      options: [
        { value: "", label: "No epic" },
        { value: "task-1", label: "task-1 · Plan" },
        { value: "task-5", label: "task-5 · Other" },
      ],
    });
    expect(taskDetailView(b.tasks[3], b, ROSTER, NOW).parent?.value).toBe("");
    expect(taskDetailView(b.tasks[3], b, ROSTER, NOW).kindChip).toBeNull();
    expect(taskDetailView(b.tasks[3], b, ROSTER, NOW).epic).toBeNull();
  });

  it("says in the activity where a task went among epics", () => {
    const at = 1;
    const log = [
      { at, from: "lead", field: "parent" as const, was: null, now: "task-1" },
      { at, from: "lead", field: "parent" as const, was: "task-1", now: "task-5" },
      { at, from: "user", field: "parent" as const, was: "task-5", now: null },
    ];
    expect(changesOf({ log }, NOW).map((c) => c.text)).toEqual([
      "put under the epic task-1",
      "moved from the epic task-1 to task-5",
      "taken out of the epic task-5",
    ]);
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
      { slug: "kd-tasks", title: "KeepDeck Tasks", known: true, openTitle: "Open in the browser — kd-tasks", detachLabel: "Detach kd-tasks" },
      { slug: "gone", title: "gone", known: false, openTitle: "No longer published — gone", detachLabel: "Detach gone" },
    ]);
    expect(view.canAttach).toBe(true);
    expect(view.palette("artifact").sections).toEqual([
      { title: TASK_DETAIL_WORDS.artifactsSection, items: [{ value: "kd-tasks-ui", label: "UI prototypes", hint: "kd-tasks-ui" }] },
    ]);
    expect(view.attachEmpty).toBeNull();
    expect(taskDetailView(b.tasks[0], b, ROSTER, NOW, []).attachEmpty?.title).toContain("Nothing published");
    expect(taskDetailView(b.tasks[0], b, ROSTER, NOW, []).attachEmpty?.text).toBe("none");
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

describe("commentsOf / changesOf — what was said, and what was changed, apart", () => {
  const change = (at: number, now: string) => ({ at, from: "lead", field: "status" as const, was: null, now });
  const comment = (n: number, at: number) => ({ n, at, from: "impl-1", body: `c${n}` });
  const shape = (log: ReturnType<typeof change>[]) => changesOf({ log }, 10_000).map((item) => item.text);

  it("lists what was said oldest first, and every change oldest first — nothing folds", () => {
    expect(commentsOf({ comments: [comment(1, 2), comment(2, 3)] }, 10_000).map((c) => c.body)).toEqual(["c1", "c2"]);
    const log = [1, 2, 3, 4, 5].map((at) => change(at, `s${at}`));
    expect(shape(log)).toEqual(["s1", "s2", "s3", "s4", "s5"].map((now) => `status: — → ${now}`));
  });

  it("shows the comments always, the activity shut until its heading opens it", () => {
    const b = board([task({ id: "task-1", log: [change(1, "a")], comments: [comment(1, 2)] })]);
    const rest = taskDetailView(b.tasks[0], b, ROSTER, 0);
    expect(rest.activity).toEqual({ label: "Activity", open: false });
    expect(rest.comments).toHaveLength(1);
    expect(taskDetailView(b.tasks[0], b, ROSTER, 0, [], true).activity.open).toBe(true);
  });

  it("keys every change uniquely — twins, the same moment and field, included", () => {
    const twins = changesOf({ log: [change(1, "a"), change(1, "b")] }, 0);
    expect(new Set(twins.map((item) => item.key)).size).toBe(2);
  });

  it("says a label put on or taken off, one line each — not the sets before and after", () => {
    const labels = (at: number, was: string | null, now: string | null) => ({ at, from: "lead", field: "labels" as const, was, now });
    const said = (entry: ReturnType<typeof labels>) => changesOf({ log: [entry] }, 0).map((item) => item.text);
    expect(said(labels(1, null, "ui"))).toEqual(["added label ui"]);
    expect(said(labels(1, "test", null))).toEqual(["removed label test"]);
    // One entry that swapped a set (an agent's replace) says each move.
    expect(said(labels(1, "a,b", "b,c"))).toEqual(["added label c", "removed label a"]);
    expect(new Set(changesOf({ log: [labels(1, "a,b", "b,c")] }, 0).map((item) => item.key)).size).toBe(2);
  });

  it("offers the task's menu: Duplicate, and Transfer — refused, with why, where it cannot go", () => {
    const teams = [{ id: "team-1", name: "api" }, { id: "team-2", name: "web" }];
    const b = board([task({ id: "task-4" }), task({ id: "task-5", status: "done" })]);
    const view = taskDetailView(b.tasks[0], b, ROSTER, 0, [], false, teams);
    expect(view.menu).toEqual({
      label: "More for task-4",
      actions: [
        { id: "rename", label: "Rename", refusal: null },
        // task-5 is done: nothing open on the team to link it with.
        { id: "blocked-by", label: "Blocked by…", refusal: "No task on its team it could wait on" },
        { id: "blocks", label: "Blocks…", refusal: "No task on its team could wait on it" },
        { id: "duplicate", label: "Duplicate", refusal: null },
        { id: "transfer", label: "Transfer", refusal: null },
      ],
    });
    // A copy is asked for, never made by a stray click; the words say where it lands.
    expect(view.duplicate.title).toBe("Duplicate task-4");
    expect(view.duplicate.message).toContain("in To do, unassigned");
    const parked = board([task({ id: "task-7", status: "backlog" })]);
    expect(taskDetailView(parked.tasks[0], parked, ROSTER, 0).duplicate.message).toContain("in Backlog");
    // Only the other teams are offered.
    expect(view.transfer.options).toEqual([{ value: "team-2", label: "web" }]);
    // The picker opens on the first team it may go to.
    expect(view.transfer.initial).toBe("team-2");
    const refusal = (t: typeof b.tasks[number], within = teams) =>
      taskDetailView(t, b, ROSTER, 0, [], false, within).menu.actions.find((a) => a.id === "transfer")!.refusal;
    expect(refusal(b.tasks[0], [teams[0]])).toBe("No other team in this workspace");
    expect(refusal(b.tasks[1])).toContain("done task stays where it is");
    const linked = board([task({ id: "task-4" }), task({ id: "task-6", blockedBy: ["task-4"] })]);
    expect(taskDetailView(linked.tasks[0], linked, ROSTER, 0, [], false, teams).menu.actions.find((a) => a.id === "transfer")!.refusal).toContain("task-6 waits on it");
  });

  it("renames to the typed title — nothing for an empty one, or for the title the edit began with", () => {
    expect(renamedTitle("Draft", "  Draft the skill ")).toBe("Draft the skill");
    expect(renamedTitle("Draft", "   ")).toBeNull();
    // Untouched since it began: no write, even if the title changed meanwhile.
    expect(renamedTitle("Draft", " Draft ")).toBeNull();
  });

  it("warns, in the transfer's confirm, that work under way stops", () => {
    const teams = [{ id: "team-1", name: "api" }, { id: "team-2", name: "web" }];
    const b = board([task({ id: "task-1", status: "in-progress", assignee: "impl-1" }), task({ id: "task-2" })]);
    const confirm = (t: typeof b.tasks[number]) => taskDetailView(t, b, ROSTER, 0, [], false, teams).transfer.confirm("web");
    expect(confirm(b.tasks[0])).toContain("It is in progress with impl-1 — that work stops here.");
    expect(confirm(b.tasks[1])).not.toContain("stops");
  });

  it("says a transfer in words, by the teams' names", () => {
    const entry = { at: 1, from: "lead", field: "transferred" as const, was: "api", now: "web" };
    expect(changesOf({ log: [entry] }, 0).map((c) => c.text)).toEqual(["moved from api to web"]);
  });

  it("says a copy's two ends in words", () => {
    const entry = (field: "copiedFrom" | "copiedTo", now: string) => ({ at: 1, from: "lead", field, was: null, now });
    expect(changesOf({ log: [entry("copiedFrom", "task-1")] }, 0).map((c) => c.text)).toEqual(["copied from task-1"]);
    expect(changesOf({ log: [entry("copiedTo", "task-9")] }, 0).map((c) => c.text)).toEqual(["copied to task-9"]);
  });

  it("keeps a change's key as the log is cut from the front at its cap", () => {
    const log = [1, 2, 3, 4, 5].map((at) => change(at, `s${at}`));
    const keyOf = (feed: ReturnType<typeof changesOf>, text: string) => feed.find((item) => item.text === text)?.key;
    const before = changesOf({ log }, 0);
    const after = changesOf({ log: [...log.slice(1), change(6, "s6")] }, 0);
    expect(keyOf(after, "status: — → s3")).toBe(keyOf(before, "status: — → s3"));
  });

  it("shows every comment and every change, however many — nothing is cut", () => {
    const b = board([task({ id: "task-1" })]);
    const view = (over: Partial<ReturnType<typeof task>>) => taskDetailView(task({ id: "task-1", ...over }), b, ROSTER, 0);
    const longLog = view({ log: Array.from({ length: 520 }, (_, i) => change(i, `s${i}`)) });
    expect(longLog.changes).toHaveLength(520);
    const longTalk = view({ comments: Array.from({ length: 250 }, (_, i) => comment(i + 1, i)) });
    expect(longTalk.comments).toHaveLength(250);
  });
});

describe("taskDetailView — a task's copy links", () => {
  const b = board(
    [task({ id: "task-1", title: "Source" }), task({ id: "task-2", title: "Copy" }), task({ id: "task-3" }), task({ id: "task-4" })],
    5,
    [relation("copied-from", "task-2", "task-1"), relation("copied-from", "task-4", "task-9")],
  );
  const rows = (index: number) => taskDetailView(b.tasks[index], b, ROSTER, NOW).copies;

  it("says where a copy came from, and what was copied from a source — each a task to open", () => {
    expect(rows(1)).toEqual([{ label: TASK_DETAIL_WORDS.copiedFromLabel, tasks: [{ id: "task-1", title: "Source" }], gone: null }]);
    expect(rows(0)).toEqual([{ label: TASK_DETAIL_WORDS.copiesLabel, tasks: [{ id: "task-2", title: "Copy" }], gone: null }]);
  });

  it("says a source no longer on the board is gone, and says nothing of a task that is no copy", () => {
    expect(rows(3)).toEqual([{ label: TASK_DETAIL_WORDS.copiedFromLabel, tasks: [], gone: TASK_DETAIL_WORDS.copyGone }]);
    expect(rows(2)).toEqual([]);
  });
});

describe("taskDetailView — linking tasks from the open one", () => {
  const b = board([
    task({ id: "task-1", blockedBy: ["task-2"] }),
    task({ id: "task-2" }),
    task({ id: "task-3", title: "Ship", status: "in-progress" }),
  ]);
  const view = taskDetailView(b.tasks[0], b, ROSTER, NOW);

  it("offers, in a palette that names what is picked, the tasks it could wait on — key, title, ring, status", () => {
    expect(view.palette("blocked-by")).toEqual({
      label: "Blocked by",
      placeholder: "Find a task task-1 waits on…",
      empty: TASK_DETAIL_WORDS.noTaskMatches,
      sections: [
        { title: "Tasks", items: [{ value: "task-3", label: "task-3  Ship", hint: "In progress", ring: statusMark("in-progress") }] },
      ],
    });
    expect(view.canAddBlocker).toBe(true);
    expect(view.blockers.map((chip) => chip.removeLabel)).toEqual(["Stop waiting on task-2"]);
  });

  it("offers the other side too: what could wait on it — never what it waits on (a cycle)", () => {
    expect(view.palette("blocks").placeholder).toBe("Find a task that waits on task-1…");
    expect(view.palette("blocks").sections[0].items.map((item: { value: string }) => item.value)).toEqual(["task-3"]);
    expect(view.canAddDependant).toBe(true);
  });

  it("puts both in the task's menu, each refused with its reason when nothing could be linked", () => {
    const actions = (v: typeof view) => v.menu.actions.filter((a) => a.id === "blocked-by" || a.id === "blocks");
    expect(actions(view)).toEqual([
      { id: "blocked-by", label: "Blocked by…", refusal: null },
      { id: "blocks", label: "Blocks…", refusal: null },
    ]);
    const alone = board([task({ id: "task-1" })]);
    const lone = taskDetailView(alone.tasks[0], alone, ROSTER, NOW);
    expect(actions(lone).map((a) => a.refusal)).toEqual([TASK_DETAIL_WORDS.nothingToWaitOn, TASK_DETAIL_WORDS.nothingWaitsOn]);
    expect([lone.canAddBlocker, lone.canAddDependant]).toEqual([false, false]);
    // Nothing waits on it and nothing could: no Unblocks row. Something
    // could: the row is drawn, its + the way to add the first.
    expect(lone.unblocksShown).toBe(false);
    expect(lone.unblocksEmpty).toBe("none");
    expect(view.unblocks).toEqual([]);
    expect(view.unblocksShown).toBe(true);
    // The row says none until something waits on it.
    expect(view.unblocksEmpty).toBe("none");
    const waited = board([task({ id: "task-1" }), task({ id: "task-2" })], 3, [relation("blocks", "task-1", "task-2")]);
    expect(taskDetailView(waited.tasks[0], waited, ROSTER, NOW).unblocksEmpty).toBeNull();
  });
});

describe("menuActionDisabled — what the open task's menu holds back", () => {
  const action = (id: "duplicate" | "transfer" | "rename", refusal: string | null = null) => ({ id, label: id, refusal });
  it("holds back what the board refuses, and a second copy while one is on its way — only that", () => {
    expect(menuActionDisabled(action("transfer", "no other team"), false)).toBe(true);
    expect(menuActionDisabled(action("duplicate"), true)).toBe(true);
    expect(menuActionDisabled(action("duplicate"), false)).toBe(false);
    expect(menuActionDisabled(action("rename"), true)).toBe(false);
  });
});
