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
  it("registers seven commands and unregisters them together", () => {
    const { registry, dispose } = setup();
    expect(registry.list().map((c) => c.id).sort()).toEqual([
      "task.comment",
      "task.create",
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
    expect(changed).toEqual({ id: "task-1", changed: ["assignee", "priority", "title", "artifacts"], status: "todo", assignee: "impl-2", priority: "low" });
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

  it("promises no delivery anywhere in what an agent reads", async () => {
    const { registry, run } = setup();
    const words = JSON.stringify(registry.list()) + JSON.stringify(await run("task.create", { title: "x", assignee: "impl-1" }, LEAD));
    for (const promise of ["will reach", "next turn", "turn boundary", "wakes", "delivered to"]) {
      expect(words).not.toContain(promise);
    }
  });
});
