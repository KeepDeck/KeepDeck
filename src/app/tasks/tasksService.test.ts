import { describe, expect, it } from "vitest";
import { USER_ACTOR, agentActor, encodeBoard, type TaskBoard } from "../../domain/tasks";
import { board, task } from "../../domain/tasks/testSupport";
import { createTasksService, type TaskEvent } from "./tasksService";
import { fakeStore, teamedWorkspaces } from "./testSupport";

const lead = agentActor("lead", "team-1");
const impl1 = agentActor("impl-1", "team-1");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(files: Record<string, string> = {}) {
  const store = fakeStore(files);
  const workspaces = teamedWorkspaces();
  const events: TaskEvent[] = [];
  const service = createTasksService({ workspaces: () => workspaces, store: store.port, now: () => 42 });
  service.onEvent((event) => events.push(event));
  return { service, store, events, workspaces };
}

describe("createTasksService", () => {
  it("a workspace never written loads as an empty board, and asking is what starts the load", async () => {
    const { service } = setup();
    let told = 0;
    service.subscribe(() => (told += 1));
    expect(service.board("ws-1")).toEqual({ kind: "loading" });
    expect(await service.ready("ws-1")).toEqual({ kind: "ready", board: { nextId: 1, tasks: [] } });
    expect(told).toBeGreaterThanOrEqual(2);
  });

  it("a stored board comes back decoded", async () => {
    const stored = board([task({ id: "task-1", assignee: "impl-1" })], 5);
    const { service } = setup({ "ws-1": encodeBoard(stored) });
    expect(await service.ready("ws-1")).toEqual({ kind: "ready", board: stored });
  });

  it("a board that does not decode is unreadable: refused for writing, never written back", async () => {
    const { service, store } = setup({ "ws-1": '{"nextId":1,"tasks":[{"id":"task-1"}]}' });
    const state = await service.ready("ws-1");
    expect(state.kind).toBe("unreadable");
    const result = await service.create("ws-1", { teamId: "team-1", title: "x" }, lead);
    expect(!result.ok && result.refusal.kind).toBe("board-unreadable");
    await flush();
    expect(store.writes).toEqual([]);
  });

  it("creating writes the whole board, encoded, and announces the task", async () => {
    const { service, store, events } = setup();
    const result = await service.create("ws-1", { teamId: "team-1", title: "Draft", assignee: "impl-1" }, lead);
    expect(result.ok && result.task.id).toBe("task-1");
    await flush();
    expect(store.writes).toHaveLength(1);
    expect(JSON.parse(store.writes[0].json)).toMatchObject({ nextId: 2, tasks: [{ id: "task-1", assignee: "impl-1", author: "lead", created: 42 }] });
    expect(events.map((e) => e.kind)).toEqual(["created"]);
  });

  it("the roster is the team's live roles, so an assignee off the team is refused", async () => {
    const { service } = setup();
    expect(service.rosterOf("ws-1", "team-1")).toEqual(["lead", "impl-1", "impl-2"]);
    expect(service.rosterOf("ws-1", "team-9")).toEqual([]);
    const result = await service.create("ws-1", { teamId: "team-1", title: "x", assignee: "tester-1" }, lead);
    expect(!result.ok && result.refusal).toEqual({ kind: "assignee-not-on-team", assignee: "tester-1" });
  });

  it("applies several changes as one: a refusal in the middle leaves the board and the disk untouched", async () => {
    const { service, store } = setup();
    await service.create("ws-1", { teamId: "team-1", title: "x", assignee: "impl-1" }, lead);
    await flush();
    const before = service.board("ws-1");
    const result = await service.apply(
      "ws-1",
      "task-1",
      [
        { kind: "priority", to: "high" },
        { kind: "status", to: "review" }, // todo → review: not an edge
      ],
      lead,
    );
    expect(!result.ok && result.refusal).toEqual({ kind: "illegal-transition", from: "todo", to: "review" });
    expect(service.board("ws-1")).toBe(before);
    await flush();
    expect(store.writes).toHaveLength(1);
  });

  it("an unknown id is this owner's refusal, not the domain's", async () => {
    const { service } = setup();
    const result = await service.apply("ws-1", "task-9", [{ kind: "comment", body: "?" }], lead);
    expect(!result.ok && result.refusal).toEqual({ kind: "unknown-task", id: "task-9" });
  });

  it("emits blocked and done — and nothing for in progress or review", async () => {
    const { service, events } = setup();
    await service.create("ws-1", { teamId: "team-1", title: "x", assignee: "impl-1" }, lead);
    await service.apply("ws-1", "task-1", [{ kind: "status", to: "in-progress" }], impl1);
    await service.apply("ws-1", "task-1", [{ kind: "status", to: "blocked" }], impl1);
    await service.apply("ws-1", "task-1", [{ kind: "status", to: "in-progress" }], impl1);
    await service.apply("ws-1", "task-1", [{ kind: "status", to: "review" }], impl1);
    await service.apply("ws-1", "task-1", [{ kind: "status", to: "done" }], USER_ACTOR);
    expect(events.map((e) => `${e.kind}:${e.actor.kind}`)).toEqual(["created:agent", "blocked:agent", "done:user"]);
  });

  it("writes one workspace's boards in order, and a failed write keeps the board in memory for the next", async () => {
    const { service, store } = setup();
    await service.create("ws-1", { teamId: "team-1", title: "a" }, lead);
    store.failNextWrite("disk full");
    await service.create("ws-1", { teamId: "team-1", title: "b" }, lead);
    await service.create("ws-1", { teamId: "team-1", title: "c" }, lead);
    await flush();
    const last = JSON.parse(store.files.get("ws-1")!) as TaskBoard;
    expect(last.tasks.map((t) => t.title)).toEqual(["a", "b", "c"]);
    expect(store.writes.map((w) => (JSON.parse(w.json) as TaskBoard).tasks.length)).toEqual([1, 3]);
  });

  it("forgetting a workspace drops its board; the next ask loads afresh", async () => {
    const { service, store } = setup();
    await service.create("ws-1", { teamId: "team-1", title: "a" }, lead);
    await flush();
    service.forget("ws-1");
    store.files.delete("ws-1");
    expect(service.board("ws-1")).toEqual({ kind: "loading" });
    expect(await service.ready("ws-1")).toEqual({ kind: "ready", board: { nextId: 1, tasks: [] } });
  });
});
