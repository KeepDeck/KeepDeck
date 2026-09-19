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
  const timers: (() => void)[] = [];
  const service = createTasksService({
    workspaces: () => workspaces,
    store: store.port,
    now: () => 42,
    schedule: (fn) => {
      timers.push(fn);
      return () => {
        const at = timers.indexOf(fn);
        if (at >= 0) timers.splice(at, 1);
      };
    },
  });
  service.onEvent((event) => events.push(event));
  /** Fire every armed retry once. */
  const tick = () => {
    for (const fn of timers.splice(0)) fn();
  };
  return { service, store, events, workspaces, tick };
}

describe("createTasksService", () => {
  it("a workspace never written loads as an empty board, and asking is what starts the load", async () => {
    const { service } = setup();
    let told = 0;
    service.subscribe(() => (told += 1));
    expect(service.board("ws-1")).toEqual({ kind: "loading" });
    expect(await service.ready("ws-1")).toEqual({ kind: "ready", board: { nextId: 1, tasks: [] }, unsaved: null });
    expect(told).toBeGreaterThanOrEqual(2);
  });

  it("a stored board comes back decoded", async () => {
    const stored = board([task({ id: "task-1", assignee: "impl-1" })], 5);
    const { service } = setup({ "ws-1": encodeBoard(stored) });
    expect(await service.ready("ws-1")).toEqual({ kind: "ready", board: stored, unsaved: null });
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

  it("two commands landing at once both take: neither reads a board the other is about to replace", async () => {
    const { service, store } = setup();
    await service.ready("ws-1");
    const [a, b] = await Promise.all([
      service.create("ws-1", { teamId: "team-1", title: "first" }, lead),
      service.create("ws-1", { teamId: "team-1", title: "second" }, lead),
    ]);
    expect(a.ok && a.task.id).toBe("task-1");
    expect(b.ok && b.task.id).toBe("task-2");
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks.map((t) => t.title)).toEqual(["first", "second"]);
    // An update racing a create sees the create.
    const [c, d] = await Promise.all([
      service.create("ws-1", { teamId: "team-1", title: "third" }, lead),
      service.apply("ws-1", "task-1", [{ kind: "priority", to: "high" }], lead),
    ]);
    expect(c.ok && d.ok).toBe(true);
    await flush();
    const last = JSON.parse(store.files.get("ws-1")!) as TaskBoard;
    expect(last.tasks.map((t) => `${t.id}:${t.priority}`)).toEqual(["task-1:high", "task-2:normal", "task-3:normal"]);
  });

  it("forgetting a workspace drops its board; the next ask loads afresh", async () => {
    const { service, store } = setup();
    await service.create("ws-1", { teamId: "team-1", title: "a" }, lead);
    await flush();
    service.forget("ws-1");
    store.files.delete("ws-1");
    expect(service.board("ws-1")).toEqual({ kind: "loading" });
    expect(await service.ready("ws-1")).toEqual({ kind: "ready", board: { nextId: 1, tasks: [] }, unsaved: null });
  });

  it("a failed write is not a silent success: the caller hears it, the board shows it, and a retry lands it", async () => {
    const { service, store, tick } = setup();
    await service.create("ws-1", { teamId: "team-1", title: "kept" }, lead);
    store.failNextWrite("disk full");
    const result = await service.create("ws-1", { teamId: "team-1", title: "not saved yet" }, lead);
    expect(result.ok && result.saved).toBe(false);
    expect(result.ok && result.saveError).toBe("disk full");
    let state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.unsaved).toBe("disk full");
    expect((JSON.parse(store.files.get("ws-1")!) as TaskBoard).tasks).toHaveLength(1);
    // The retry, when its time comes, writes the board memory holds.
    tick();
    await service.flush();
    await flush();
    state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.unsaved).toBeNull();
    expect((JSON.parse(store.files.get("ws-1")!) as TaskBoard).tasks.map((t) => t.title)).toEqual(["kept", "not saved yet"]);
  });

  it("a later successful write clears the mark; a success that is not the latest write does not", async () => {
    const { service, store } = setup();
    store.failNextWrite("disk full");
    const failed = await service.create("ws-1", { teamId: "team-1", title: "a" }, lead);
    expect(failed.ok && failed.saved).toBe(false);
    const landed = await service.create("ws-1", { teamId: "team-1", title: "b" }, lead);
    expect(landed.ok && landed.saved).toBe(true);
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.unsaved).toBeNull();
    expect((JSON.parse(store.files.get("ws-1")!) as TaskBoard).tasks.map((t) => t.title)).toEqual(["a", "b"]);
  });
});
