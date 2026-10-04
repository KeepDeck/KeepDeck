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
  it("registers eight commands and unregisters them together", () => {
    const { registry, dispose } = setup();
    expect(registry.list().map((c) => c.id).sort()).toEqual([
      "task.comment",
      "task.create",
      "task.duplicate",
      "task.get",
      "task.list",
      "task.mine",
      "task.next",
      "task.update",
    ]);
    dispose();
    expect(registry.list()).toEqual([]);
  });

  it("refuses a caller it cannot place: anonymous, or a pane on no team", async () => {
    const { refused } = setup();
    expect(await refused("task.create", { title: "x" }, ANONYMOUS)).toContain("not attached to one");
    expect(await refused("task.create", { title: "x" }, LONER)).toContain("on no team");
    expect(await refused("task.mine", {}, LONER)).toContain("on no team");
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
    expect(JSON.stringify(original)).toContain("copiedTo");
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
    // Nothing to take — but the parked work is named, and whose call it is.
    const next = await run("task.next", {}, IMPL1);
    expect(next.note).toContain("1 parked in the backlog");
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
    expect(await refused("task.list", { team: "web" }, LEAD)).toContain('you stand on "api", not "web"');
    expect(await refused("task.list", { team: "nope" }, LEAD)).toContain('no team "nope"');
    await run("task.create", { title: "web's" }, OTHER_LEAD);
    expect(await refused("task.get", { id: "task-1" }, LEAD)).toContain("another team's board");
    expect(await refused("task.comment", { id: "task-1", body: "hi" }, LEAD)).toContain("another team's board");
    // The same team by name is fine — it is the caller's own.
    expect(await run("task.list", { team: "api" }, LEAD)).toMatchObject({ count: 0 });
  });

  it("list filters by assignee (pool included) and status, and rows carry no body or thread", async () => {
    const { run } = setup();
    await run("task.create", { title: "a", assignee: "impl-1", body: "secret brief" }, LEAD);
    await run("task.create", { title: "b" }, LEAD);
    await run("task.update", { id: "task-1", status: "in-progress" }, IMPL1);
    const all = await run("task.list", {}, LEAD);
    expect(all.count).toBe(2);
    expect(JSON.stringify(all)).not.toContain("secret brief");
    expect((all.tasks as { id: string; issuable: boolean }[]).map((t) => `${t.id}:${t.issuable}`)).toEqual([
      "task-1:false",
      "task-2:true",
    ]);
    expect((await run("task.list", { assignee: "pool" }, LEAD)).count).toBe(1);
    expect((await run("task.list", { status: "in-progress" }, LEAD)).count).toBe(1);
    expect((await run("task.list", { assignee: "impl-2" }, LEAD)).count).toBe(0);
  });

  it("get carries the task whole with its blockers' statuses and what it unblocks", async () => {
    const { run } = setup();
    await run("task.create", { title: "first", body: "the brief" }, LEAD);
    await run("task.create", { title: "second", blockedBy: "task-1" }, LEAD);
    await run("task.comment", { id: "task-1", body: "on it" }, IMPL1);
    const got = (await run("task.get", { id: "task-1" }, IMPL1)).task as Record<string, unknown>;
    expect(got).toMatchObject({ id: "task-1", body: "the brief", unblocks: ["task-2"], issuable: true });
    expect(got.comments).toEqual([{ n: 1, at: 42, from: "impl-1", body: "on it" }]);
    const second = (await run("task.get", { id: "task-2" }, IMPL1)).task as Record<string, unknown>;
    expect(second).toMatchObject({ blockers: [{ id: "task-1", status: "todo" }], issuable: false });
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
    });
    expect((await run("task.update", { id: "task-1", assignee: "pool" }, LEAD)).assignee).toBeNull();
    expect(await refused("task.update", { id: "task-1" }, LEAD)).toContain("nothing to change");
    expect(await refused("task.update", { id: "pane-1", status: "in-progress" }, LEAD)).toContain("not a task id");
    expect(await refused("task.update", { id: "task-9", status: "in-progress" }, LEAD)).toContain("no such task");
    expect(await refused("task.update", { id: "task-1", status: "later" }, LEAD)).toContain("status must be");
    expect(await refused("task.create", { title: "x", priority: "urgent" }, LEAD)).toContain("priority must be");
  });

  it("next hands out the first startable task and says where the pool stands", async () => {
    const { run } = setup();
    await run("task.create", { title: "blocker", assignee: "impl-1", priority: "high" }, LEAD);
    await run("task.create", { title: "waits", assignee: "impl-1", priority: "high", blockedBy: "task-1" }, LEAD);
    await run("task.create", { title: "free", assignee: "impl-1", priority: "low" }, LEAD);
    await run("task.create", { title: "pooled" }, LEAD);
    const next = await run("task.next", {}, IMPL1);
    expect((next.task as { id: string }).id).toBe("task-1");
    expect(next.pool).toBe(1);
    const nothing = await run("task.next", {}, IMPL2);
    expect(nothing.task).toBeNull();
    expect(nothing.note).toContain("the pool holds 1");
  });

  it("mine is the caller's plate; the lead also sees the team's review", async () => {
    const { run } = setup();
    await run("task.create", { title: "a", assignee: "impl-1" }, LEAD);
    await run("task.create", { title: "b", assignee: "impl-2" }, LEAD);
    await run("task.update", { id: "task-2", status: "in-progress" }, IMPL2);
    await run("task.update", { id: "task-2", status: "review" }, IMPL2);
    expect(((await run("task.mine", {}, IMPL1)).tasks as { id: string }[]).map((t) => t.id)).toEqual(["task-1"]);
    expect(((await run("task.mine", {}, LEAD)).tasks as { id: string }[]).map((t) => t.id)).toEqual(["task-2"]);
  });

  it("labels: set at creation and by update, listed on rows, and a list narrows to one", async () => {
    const { run, refused } = setup();
    await run("task.create", { title: "Copy pass", assignee: "impl-1", labels: "Copy Edit, ui" }, LEAD);
    await run("task.create", { title: "Other" }, LEAD);
    const listed = (await run("task.list", { label: "copy edit" }, LEAD)).tasks as { id: string; labels: string[] }[];
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
    expect(await refused("task.list", { label: "--" }, LEAD)).toContain('"--" is not a label');
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
