import { describe, expect, it } from "vitest";
import { createCommandRegistry, type CommandArgs, type CommandSource } from "../../domain/commands";
import { registerTaskCommands } from "./taskCommands";
import { createTasksService } from "./tasksService";
import { ANONYMOUS, fakeStore, from, teamedWorkspaces } from "./testSupport";

function setup() {
  const workspaces = teamedWorkspaces();
  const store = fakeStore();
  const tasks = createTasksService({ workspaces: () => workspaces, store: store.port, now: () => 42 });
  const registry = createCommandRegistry();
  const dispose = registerTaskCommands(registry, { tasks, workspaces: () => workspaces });
  const run = async (id: string, args: CommandArgs, source: CommandSource) => {
    const result = await registry.execute(id, args, source);
    if (!result.ok) throw new Error(result.error.message);
    return result.value as Record<string, unknown>;
  };
  const refused = async (id: string, args: CommandArgs, source: CommandSource) => {
    const result = await registry.execute(id, args, source);
    if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);
    return result.error.message;
  };
  return { registry, tasks, store, run, refused, dispose };
}

const LEAD = from("pane-1");
const IMPL1 = from("pane-2");
const IMPL2 = from("pane-3");
const OTHER_LEAD = from("pane-5");
const LONER = from("pane-7");

describe("task commands", () => {
  it("registers eleven commands and unregisters them together", () => {
    const { registry, dispose } = setup();
    expect(registry.list().map((c) => c.id).sort()).toEqual([
      "task.brief",
      "task.comment",
      "task.create",
      "task.duplicate",
      "task.get",
      "task.history",
      "task.list",
      "task.search",
      "task.since",
      "task.transfer",
      "task.update",
    ]);
    dispose();
    expect(registry.list()).toEqual([]);
  });

  it("refuses a caller it cannot place: anonymous, or a pane on no team", async () => {
    const { refused } = setup();
    expect(await refused("task.create", { title: "x" }, ANONYMOUS)).toContain("not attached to one");
    expect(await refused("task.create", { title: "x" }, LONER)).toContain("on no team");
    expect(await refused("task.list", { status: "todo" }, LONER)).toContain("on no team");
  });

  it("the lead creates an assigned task and is told the board tells nobody", async () => {
    const { run } = setup();
    const created = await run("task.create", { title: "Draft the skill", assignee: "impl-1", priority: "high" }, LEAD);
    expect(created).toMatchObject({ id: "task-1", teamId: "team-1", status: "todo", priority: "high", assignee: "impl-1" });
    expect(created.note).toContain("tells nobody");
    expect(created.note).toContain("mail.send");
    expect(created.note).toContain("task-1");
    const pooled = await run("task.create", { title: "Anyone" }, LEAD);
    expect(pooled.note).toContain("pool");
  });

  it("a working role's refusals come back as sentences naming the lead", async () => {
    const { refused, run } = setup();
    expect(await refused("task.create", { title: "x", assignee: "impl-2" }, IMPL1)).toContain("lead's to set");
    await run("task.create", { title: "Theirs", assignee: "impl-2" }, LEAD);
    expect(await refused("task.update", { id: "task-1", status: "in-progress" }, IMPL1)).toContain("that task is impl-2's");
    await run("task.update", { id: "task-1", status: "in-progress" }, IMPL2);
    await run("task.update", { id: "task-1", status: "review" }, IMPL2);
    expect(await refused("task.update", { id: "task-1", status: "done" }, IMPL2)).toContain("is lead's");
  });

  it("duplicates a task as a fresh one, and says what a working role's copy could not carry", async () => {
    const { run } = setup();
    await run("task.create", { title: "Original", priority: "high", labels: "ui" }, LEAD);
    const copy = await run("task.duplicate", { id: "task-1" }, LEAD);
    expect(copy).toMatchObject({ id: "task-2", copiedFrom: "task-1", status: "todo", priority: "high" });
    const mine = await run("task.duplicate", { id: "task-1" }, IMPL1);
    expect(mine.note).toContain("not carried over: priority (high)");
    expect(mine.note).toContain("labels");
    const original = await run("task.get", { id: "task-1" }, LEAD);
    // Its log says so — the log is task.history's.
    expect(JSON.stringify(await run("task.history", { id: "task-1" }, LEAD))).toContain("copiedTo");
    // The link, both ways, by key — and no uid: agents address keys only.
    expect(original.task).toMatchObject({ copiedFrom: null, copies: ["task-2", "task-3"] });
    const read = (await run("task.get", { id: "task-2" }, LEAD)).task;
    expect(read).toMatchObject({ copiedFrom: "task-1", copies: [], blockedBy: [], title: "Original" });
    expect(read).not.toHaveProperty("uid");
    // Where the copy went is said as it is: a parked source's copy is parked.
    await run("task.update", { id: "task-1", status: "backlog" }, LEAD);
    const parked = await run("task.duplicate", { id: "task-1" }, LEAD);
    expect(parked.note).toContain("parked in the team's backlog");
    expect(parked.note).not.toContain("pool");
  });

  it("transfers a task to another team by name, the lead's to do, and says to tell them", async () => {
    const { run, refused } = setup();
    await run("task.create", { title: "Hand over", assignee: "impl-1" }, LEAD);
    expect(await refused("task.transfer", { id: "task-1", to: "web" }, IMPL1)).toContain("handing a task to another team is lead's");
    const moved = await run("task.transfer", { id: "task-1", to: "web" }, LEAD);
    expect(moved).toMatchObject({ id: "task-1", team: "web" });
    expect(moved.note).toContain("tell its lead with mail.send");
    // Who held it is named too: it loses the task without a word from the board.
    expect(moved.note).toContain("impl-1, who held it");
    // Off this team's board now: the lead reads only its own.
    expect(await refused("task.get", { id: "task-1" }, LEAD)).toContain("another team's board");
    expect(await refused("task.transfer", { id: "task-1", to: "nowhere" }, LEAD)).toBeTruthy();
  });

  it("refuses a title past its cap in words an agent can act on", async () => {
    const { run, refused } = setup();
    const long = "x".repeat(134);
    const said = "title is 134 characters — at most 120; shorten it by 14";
    expect(await refused("task.create", { title: long }, LEAD)).toBe(said);
    await run("task.create", { title: "Short" }, LEAD);
    expect(await refused("task.update", { id: "task-1", title: long }, LEAD)).toBe(said);
    // Spaces at the ends are never kept, so they never count.
    const padded = `  ${"y".repeat(120)}   `;
    const made = await run("task.create", { title: padded }, LEAD);
    const kept = await run("task.get", { id: made.id as string }, LEAD);
    expect((kept.task as { title: string }).title).toBe("y".repeat(120));
  });

  it("creates into the backlog when asked — never issuable there — and refuses any other start", async () => {
    const { run, refused } = setup();
    await run("task.create", { title: "Idea", status: "backlog" }, IMPL1);
    const listed = (await run("task.list", { status: "backlog" }, LEAD)).tasks as { id: string; issuable: boolean }[];
    expect(listed.map((t) => [t.id, t.issuable])).toEqual([["task-1", false]]);
    expect(await refused("task.create", { title: "x", status: "done" }, LEAD)).toContain("created in todo or backlog");
    expect(await refused("task.list", { status: "parked" }, LEAD)).toContain("backlog, todo");
  });

  it("an illegal move teaches the ladder: the refusal says where the task can go from here", async () => {
    const { run, refused } = setup();
    await run("task.create", { title: "Already shipped", assignee: "impl-1" }, LEAD);
    expect(await refused("task.update", { id: "task-1", status: "done" }, LEAD)).toBe(
      "a task cannot go from todo to done — from todo it can go to backlog, in-progress, cancelled",
    );
    await run("task.update", { id: "task-1", status: "in-progress" }, IMPL1);
    await run("task.update", { id: "task-1", status: "review" }, IMPL1);
    // Review is the lead's to accept: the worker's list is empty, and said so.
    expect(await refused("task.update", { id: "task-1", status: "todo" }, IMPL1)).toBe(
      "a task cannot go from review to todo, and from review no move is yours",
    );
  });

  it("a board is its team's: naming another team, or reading its task, is refused", async () => {
    const { refused, run } = setup();
    expect(await refused("task.list", { team: "web", status: "todo" }, LEAD)).toContain('you stand on "api", not "web"');
    expect(await refused("task.list", { team: "nope", status: "todo" }, LEAD)).toContain('no team "nope"');
    await run("task.create", { title: "web's" }, OTHER_LEAD);
    expect(await refused("task.get", { id: "task-1" }, LEAD)).toContain("another team's board");
    expect(await refused("task.comment", { id: "task-1", body: "hi" }, LEAD)).toContain("another team's board");
    // The same team by name is fine — it is the caller's own.
    expect(await run("task.list", { team: "api", status: "todo" }, LEAD)).toMatchObject({ count: 0 });
  });

  it("list names the statuses it wants — closed work only when named — and rows carry no body or thread", async () => {
    const { run, refused } = setup();
    await run("task.create", { title: "a", assignee: "impl-1", body: "secret brief" }, LEAD);
    await run("task.create", { title: "b" }, LEAD);
    await run("task.create", { title: "c" }, LEAD);
    await run("task.update", { id: "task-1", status: "in-progress" }, IMPL1);
    await run("task.update", { id: "task-3", status: "cancelled" }, LEAD);
    expect(await refused("task.list", {}, LEAD)).toContain('missing required argument "status"');
    expect(await refused("task.list", { status: " , " }, LEAD)).toContain("name the statuses you want");
    expect(await refused("task.list", { status: "todo,later" }, LEAD)).toContain('not "later"');
    const open = await run("task.list", { status: "todo,in-progress" }, LEAD);
    expect(open.count).toBe(2);
    expect(JSON.stringify(open)).not.toContain("secret brief");
    expect((open.tasks as { id: string; issuable: boolean }[]).map((t) => `${t.id}:${t.issuable}`)).toEqual(["task-1:false", "task-2:true"]);
    expect((await run("task.list", { status: "cancelled" }, LEAD)).count).toBe(1);
    expect((await run("task.list", { status: "todo,in-progress", assignee: "pool" }, LEAD)).count).toBe(1);
    expect((await run("task.list", { status: "todo,in-progress", assignee: "impl-2" }, LEAD)).count).toBe(0);
    expect((await run("task.list", { status: "todo", priority: "high" }, LEAD)).count).toBe(0);
  });

  it("every row and every task says what it left for another call — counts only", async () => {
    const { run } = setup();
    await run("task.create", { title: "a", assignee: "impl-1" }, LEAD);
    await run("task.comment", { id: "task-1", body: "one" }, IMPL1);
    await run("task.update", { id: "task-1", body: "v2" }, LEAD);
    const [row] = (await run("task.list", { status: "todo" }, LEAD)).tasks as { more: unknown }[];
    expect(row.more).toEqual({ comments: 1, history: 1, briefVersions: 1 });
    const got = (await run("task.get", { id: "task-1" }, LEAD)).task as Record<string, unknown>;
    expect(got.more).toEqual({ comments: 1, history: 1, briefVersions: 1 });
    // The log and earlier briefs are history's, never the task's.
    expect(got).not.toHaveProperty("log");
    expect(got).not.toHaveProperty("briefs");
  });

  it("get carries the task as it stands — a closed one without its thread — with its blockers' statuses and what it unblocks", async () => {
    const { run } = setup();
    await run("task.create", { title: "first", body: "the brief" }, LEAD);
    await run("task.create", { title: "second", blockedBy: "task-1" }, LEAD);
    await run("task.comment", { id: "task-1", body: "on it" }, IMPL1);
    const got = (await run("task.get", { id: "task-1" }, IMPL1)).task as Record<string, unknown>;
    expect(got).toMatchObject({ id: "task-1", body: "the brief", unblocks: ["task-2"], issuable: true });
    expect(got.comments).toEqual([{ n: 1, at: 42, from: "impl-1", body: "on it" }]);
    const second = (await run("task.get", { id: "task-2" }, IMPL1)).task as Record<string, unknown>;
    expect(second).toMatchObject({ blockers: [{ id: "task-1", status: "todo" }], issuable: false });
    // Closed: the thread is history's, counted.
    await run("task.update", { id: "task-1", status: "cancelled" }, LEAD);
    const closed = (await run("task.get", { id: "task-1" }, IMPL1)).task as Record<string, unknown>;
    expect(closed).not.toHaveProperty("comments");
    expect(closed.more).toMatchObject({ comments: 1 });
  });

  it("every answer carries the board's rev, and every answer about one task its more — writes and reads alike", async () => {
    const { run } = setup();
    const shaped = (answer: Record<string, unknown>, aboutOne: boolean) => {
      expect(typeof answer.rev).toBe("number");
      if (aboutOne) expect(answer.more).toMatchObject({ comments: expect.any(Number), history: expect.any(Number), briefVersions: expect.any(Number) });
    };
    shaped(await run("task.create", { title: "a" }, LEAD), true);
    shaped(await run("task.comment", { id: "task-1", body: "x" }, LEAD), true);
    shaped(await run("task.update", { id: "task-1", priority: "high" }, LEAD), true);
    shaped(await run("task.duplicate", { id: "task-1" }, LEAD), true);
    for (const kind of ["log", "comments", "briefs"]) shaped(await run("task.history", { id: "task-1", kind }, LEAD), true);
    shaped(await run("task.transfer", { id: "task-2", to: "web" }, LEAD), true);
    shaped(await run("task.get", { id: "task-1" }, LEAD), false);
    shaped(await run("task.list", { status: "todo" }, LEAD), false);
    shaped(await run("task.search", { query: "a" }, LEAD), false);
    shaped(await run("task.since", { since: "0" }, LEAD), false);
    shaped(await run("task.brief", {}, LEAD), false);
  });

  it("history gives a task's log, comments or earlier briefs, the log filtered by field", async () => {
    const { run, refused } = setup();
    await run("task.create", { title: "a", assignee: "impl-1", body: "first" }, LEAD);
    await run("task.update", { id: "task-1", body: "second", priority: "high" }, LEAD);
    await run("task.comment", { id: "task-1", body: "noted" }, IMPL1);
    const log = (await run("task.history", { id: "task-1" }, IMPL1)).log as { field: string }[];
    expect(log.map((e) => e.field)).toEqual(["priority", "body"]);
    expect(((await run("task.history", { id: "task-1", field: "body" }, IMPL1)).log as unknown[]).length).toBe(1);
    expect(await run("task.history", { id: "task-1", kind: "briefs" }, IMPL1)).toEqual({
      id: "task-1",
      current: 2,
      briefs: [{ v: 1, body: "first" }],
      more: { comments: 1, history: 2, briefVersions: 1 },
      rev: 3,
    });
    expect(((await run("task.history", { id: "task-1", kind: "comments" }, IMPL1)).comments as { body: string }[]).map((c) => c.body)).toEqual(["noted"]);
    expect(await refused("task.history", { id: "task-1", kind: "everything" }, IMPL1)).toContain("kind must be");
  });

  it("search finds a task by its words, closed work included, within the caller's team and filters", async () => {
    const { run } = setup();
    await run("task.create", { title: "Move the board to SQLite" }, LEAD);
    await run("task.create", { title: "Other" }, LEAD);
    await run("task.comment", { id: "task-2", body: "we chose sqlite for it" }, LEAD);
    await run("task.update", { id: "task-2", status: "cancelled" }, LEAD);
    await run("task.create", { title: "web sqlite work" }, OTHER_LEAD);
    const found = await run("task.search", { query: "sqlite" }, LEAD);
    expect((found.hits as { id: string; matched: string }[]).map((h) => [h.id, h.matched])).toEqual([
      ["task-1", "brief"],
      ["task-2", "comment 1"],
    ]);
    expect((await run("task.search", { query: "sqlite", status: "todo" }, LEAD)).count).toBe(1);
    // Better matches of another team never crowd the caller's own out.
    for (let i = 0; i < 90; i += 1) await run("task.create", { title: `web zinc ${i}` }, OTHER_LEAD);
    await run("task.create", { title: "our zinc" }, LEAD);
    const ours = await run("task.search", { query: "zinc", limit: 5 }, LEAD);
    expect((ours.hits as { title: string }[]).map((h) => h.title)).toEqual(["our zinc"]);
  });

  it("since names what changed after a rev — or from a time — and every answer carries the rev to ask next", async () => {
    const { run, refused } = setup();
    await run("task.create", { title: "a" }, LEAD);
    await run("task.create", { title: "b" }, LEAD);
    const { rev } = await run("task.list", { status: "todo" }, LEAD);
    expect(typeof rev).toBe("number");
    await run("task.comment", { id: "task-2", body: "moved on" }, LEAD);
    const since = await run("task.since", { since: String(rev) }, LEAD);
    expect((since.tasks as { id: string }[]).map((t) => t.id)).toEqual(["task-2"]);
    expect(since.rev).toBe((rev as number) + 1);
    expect(((await run("task.since", { since: "1970-01-01T00:00:00Z" }, LEAD)).tasks as unknown[]).length).toBe(2);
    expect(await refused("task.since", { since: "yesterday-ish" }, LEAD)).toContain("neither a rev nor a time");
  });

  it("since says what changed after each mark: the comments gained, the fields moved, a task new since", async () => {
    const { run } = setup();
    await run("task.create", { title: "a" }, LEAD);
    const before = (await run("task.list", { status: "todo" }, LEAD)).rev as number;
    await run("task.comment", { id: "task-1", body: "one" }, LEAD);
    const between = (await run("task.list", { status: "todo" }, LEAD)).rev as number;
    await run("task.comment", { id: "task-1", body: "two" }, LEAD);
    await run("task.update", { id: "task-1", priority: "high" }, LEAD);
    const changed = (mark: number) => run("task.since", { since: String(mark) }, LEAD).then((a) => (a.tasks as { changed: unknown }[])[0]?.changed);
    expect(await changed(before - 1)).toEqual({ new: true, comments: 2, fields: ["priority"] });
    expect(await changed(before)).toEqual({ new: false, comments: 2, fields: ["priority"] });
    expect(await changed(between)).toEqual({ new: false, comments: 1, fields: ["priority"] });
  });

  it("brief is the board at a glance for whoever hands out work — and refuses a working role", async () => {
    const { run, refused } = setup();
    await run("task.create", { title: "a", assignee: "impl-1" }, LEAD);
    await run("task.create", { title: "b", assignee: "impl-2" }, LEAD);
    await run("task.update", { id: "task-2", status: "in-progress" }, IMPL2);
    await run("task.update", { id: "task-2", status: "review" }, IMPL2);
    const brief = await run("task.brief", {}, LEAD);
    expect(brief.board).toEqual({ backlog: 0, todo: 1, "in-progress": 0, blocked: 0, review: 1 });
    expect((brief.waitingOnYou as { id: string }[]).map((t) => t.id)).toEqual(["task-2"]);
    expect(typeof brief.rev).toBe("number");
    expect(await refused("task.brief", {}, IMPL1)).toContain("for whoever hands out work");
  });

  it("update applies several fields at once and names what changed; ids are checked by shape", async () => {
    const { run, refused } = setup();
    await run("task.create", { title: "a", assignee: "impl-1" }, LEAD);
    const changed = await run(
      "task.update",
      { id: "task-1", assignee: "impl-2", priority: "low", title: "renamed", artifacts: "kd-tasks, kd-tasks-ui" },
      LEAD,
    );
    expect(changed).toEqual({
      id: "task-1",
      changed: ["assignee", "priority", "title", "artifacts"],
      status: "todo",
      assignee: "impl-2",
      priority: "low",
      saved: true,
      more: { comments: 0, history: 4, briefVersions: 0 },
      rev: 2,
    });
    expect((await run("task.update", { id: "task-1", assignee: "pool" }, LEAD)).assignee).toBeNull();
    expect(await refused("task.update", { id: "task-1" }, LEAD)).toContain("nothing to change");
    expect(await refused("task.update", { id: "pane-1", status: "in-progress" }, LEAD)).toContain("not a task id");
    expect(await refused("task.update", { id: "task-9", status: "in-progress" }, LEAD)).toContain("no such task");
    expect(await refused("task.update", { id: "task-1", status: "later" }, LEAD)).toContain("status must be");
    expect(await refused("task.create", { title: "x", priority: "urgent" }, LEAD)).toContain("priority must be");
  });

  it("labels: set at creation and by update, listed on rows, and a list narrows to one", async () => {
    const { run, refused } = setup();
    await run("task.create", { title: "Copy pass", assignee: "impl-1", labels: "Copy Edit, ui" }, LEAD);
    await run("task.create", { title: "Other" }, LEAD);
    const listed = (await run("task.list", { status: "todo", label: "copy edit" }, LEAD)).tasks as { id: string; labels: string[] }[];
    expect(listed.map((t) => [t.id, t.labels])).toEqual([["task-1", ["copy-edit", "ui"]]]);
    // The assignee files its own task; the change is named.
    const updated = await run("task.update", { id: "task-1", labels: "ui" }, IMPL1);
    expect(updated.changed).toEqual(["labels"]);
    expect(await refused("task.update", { id: "task-2", labels: "ui" }, IMPL1)).toContain("its labels are");
    expect(await refused("task.update", { id: "task-1", labels: "a/b" }, LEAD)).toContain("is not a label");
  });

  it("refuses labels sent as an array — never drops them — and names a filter that is no label", async () => {
    const { refused } = setup();
    expect(await refused("task.create", { title: "Copy pass", labels: ["ui"] as never }, LEAD)).toContain('"labels" must be a string');
    expect(await refused("task.list", { status: "todo", label: "--" }, LEAD)).toContain('"--" is not a label');
  });

  it("tells the agent when its change is held but not on disk", async () => {
    const { run, store } = setup();
    const landed = await run("task.create", { title: "a" }, LEAD);
    expect(landed.saved).toBe(true);
    expect(landed.note).not.toContain("NOT saved");
    store.failNextWrite("disk full");
    const held = await run("task.update", { id: "task-1", priority: "high" }, LEAD);
    expect(held.saved).toBe(false);
    expect(held.note).toContain("NOT saved to disk yet (disk full)");
  });

  it("promises no delivery anywhere in what an agent reads", async () => {
    const { registry, run } = setup();
    const words = JSON.stringify(registry.list()) + JSON.stringify(await run("task.create", { title: "x", assignee: "impl-1" }, LEAD));
    for (const promise of ["will reach", "next turn", "turn boundary", "wakes", "delivered to"]) {
      expect(words).not.toContain(promise);
    }
  });
});
