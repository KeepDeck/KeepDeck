import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "../../domain/commands";
import { createEnableStatus } from "../enableStatus";
import { USER_ACTOR } from "../../domain/tasks";
import { createTasksFeature } from "./tasksFeature";
import { RETRY_WRITE_MS } from "./tasksService";
import { fakeStore, teamedWorkspaces } from "./testSupport";

/** A promise handed out to be settled by the test — a backend call that
 * takes as long as the test says. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = () => res();
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const store = fakeStore();
  let open = false;
  /** A disk that refuses every write while set. */
  let diskFull = false;
  const status = createEnableStatus();
  // Unknown until the settings load, as at boot: the policy waits for a value.
  let tasks: boolean | null = null;
  let socket = true;
  const settingsListeners = new Set<() => void>();
  const socketListeners = new Set<() => void>();
  let workspaces = teamedWorkspaces();
  const deckListeners = new Set<() => void>();
  /** Enable/disable calls, each waiting on its own gate, in order. */
  const calls: { kind: "enable" | "disable"; gate: ReturnType<typeof gate>; settled: boolean }[] = [];
  const registry = createCommandRegistry();
  const announced: unknown[] = [];
  /** Writes, drops and disables, in the order the backend saw them. */
  const order: ("write" | "drop" | "disable")[] = [];
  const feature = createTasksFeature({
    registry,
    workspaces: () => workspaces,
    subscribeWorkspaces: (l) => {
      deckListeners.add(l);
      return () => deckListeners.delete(l);
    },
    settings: {
      tasks: () => tasks,
      subscribe: (l) => {
        settingsListeners.add(l);
        return () => settingsListeners.delete(l);
      },
    },
    socket: {
      up: () => socket,
      subscribe: (l) => {
        socketListeners.add(l);
        return () => socketListeners.delete(l);
      },
    },
    store: {
      // The store refuses while closed — the sentence the real one gives.
      read: async (args) => {
        if (!open) throw new Error("task board is off — turn Tasks on first");
        return store.port.read(args);
      },
      write: async (args) => {
        if (!open) throw new Error("task board is off — turn Tasks on first");
        if (diskFull) throw new Error("disk full");
        await store.port.write(args);
        order.push("write");
      },
      enable: () => {
        const g = gate();
        calls.push({ kind: "enable", gate: g, settled: false });
        return g.promise.then(() => {
          open = true;
        });
      },
      disable: () => {
        order.push("disable");
        const g = gate();
        calls.push({ kind: "disable", gate: g, settled: false });
        return g.promise.then(() => {
          open = false;
        });
      },
      drop: async (args) => {
        if (!open) throw new Error("task board is off — turn Tasks on first");
        await store.port.drop(args);
        order.push("drop");
      },
    },
    announce: (event) => announced.push(event),
    status,
  });
  return {
    feature,
    registry,
    announced,
    calls,
    store,
    order,
    status,
    setDiskFull(next: boolean) {
      diskFull = next;
    },
    /** Flip the setting without yielding — for changes within one turn. */
    setTasksSync(next: boolean | null) {
      tasks = next;
      for (const l of [...settingsListeners]) l();
    },
    /** Flip the setting and let the policy's chain reach the backend. */
    async setTasks(next: boolean | null) {
      tasks = next;
      for (const l of [...settingsListeners]) l();
      await flush();
    },
    /** The deck changes: `edit` rewrites the workspaces, listeners hear it. */
    changeDeck(edit: (current: typeof workspaces) => typeof workspaces) {
      workspaces = edit(workspaces);
      for (const l of [...deckListeners]) l();
    },
    setSocket(next: boolean) {
      socket = next;
      for (const l of [...socketListeners]) l();
    },
    /** Settle the oldest unsettled backend call. */
    async settleNext() {
      const call = calls.find((c) => !c.settled);
      if (!call) throw new Error("no backend call waiting");
      call.settled = true;
      call.gate.resolve();
      await flush();
      await flush();
    },
  };
}

describe("createTasksFeature", () => {
  it("brings the owner up only once the store answered for the setting that stands, and the commands only with the socket", async () => {
    const h = setup();
    expect(h.feature.access.current()).toBeNull();
    await h.setTasks(true);
    expect(h.calls.map((c) => c.kind)).toEqual(["enable"]);
    expect(h.feature.access.current()).toBeNull();
    await h.settleNext();
    expect(h.feature.access.current()).not.toBeNull();
    expect(h.registry.has("task.create")).toBe(true);
    h.setSocket(false);
    expect(h.registry.has("task.create")).toBe(false);
    expect(h.feature.access.current()).not.toBeNull();
    h.setSocket(true);
    expect(h.registry.has("task.create")).toBe(true);
  });

  it("a disbanded team takes its tasks with it: the deck change prunes the board and writes it", async () => {
    const h = setup();
    await h.setTasks(true);
    await h.settleNext();
    const service = h.feature.access.current()!;
    await service.create("ws-1", { teamId: "team-1", title: "api's" }, USER_ACTOR);
    await service.create("ws-1", { teamId: "team-2", title: "web's" }, USER_ACTOR);
    await flush();
    // web is disbanded: its members leave, then the team.
    h.changeDeck((ws) =>
      ws.map((w) =>
        w.id !== "ws-1"
          ? w
          : { ...w, panes: w.panes.filter((p) => p.team?.teamId !== "team-2"), teams: w.teams!.filter((t) => t.id !== "team-2") },
      ),
    );
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks.map((t) => t.title)).toEqual(["api's"]);
    // And the disk agrees: what was written last holds api's task alone.
    expect(JSON.parse(h.store.writes[h.store.writes.length - 1].json).tasks.map((t: { title: string }) => t.title)).toEqual(["api's"]);
  });

  it("a fast Off→On does not create an owner on the previous On's answer — the board is readable afterwards", async () => {
    const h = setup();
    await h.setTasks(true);
    await h.settleNext();
    const first = h.feature.access.current()!;
    // Off: the owner goes at once; the store's disable is still out.
    await h.setTasks(false);
    expect(h.feature.access.current()).toBeNull();
    expect(h.calls.map((c) => c.kind)).toEqual(["enable", "disable"]);
    // On again before the disable settled: nothing is created yet.
    await h.setTasks(true);
    expect(h.feature.access.current()).toBeNull();
    await h.settleNext(); // disable lands (for the old value — ignored)
    expect(h.feature.access.current()).toBeNull();
    expect(h.calls.map((c) => c.kind)).toEqual(["enable", "disable", "enable"]);
    await h.settleNext(); // the enable for THIS value lands
    const second = h.feature.access.current();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    const state = await second!.ready("ws-1");
    expect(state.kind).toBe("ready");
  });

  it("an unrelated setting moving changes nothing: same owner, same commands, no new enable", async () => {
    const h = setup();
    await h.setTasks(true);
    await h.settleNext();
    const owner = h.feature.access.current();
    // The settings feed fires for every setting; the value of ours stands.
    await h.setTasks(true);
    await h.setTasks(true);
    expect(h.feature.access.current()).toBe(owner);
    expect(h.registry.has("task.create")).toBe(true);
    expect(h.calls.map((c) => c.kind)).toEqual(["enable"]);
  });

  it("On (still pending) → Off → On: the first enable's answer is not believed for the third generation", async () => {
    const h = setup();
    await h.setTasks(true); // enable #1 out
    await h.setTasks(false); // disable queued behind it
    await h.setTasks(true); // enable #3 queued behind that
    expect(h.calls.map((c) => c.kind)).toEqual(["enable"]);
    await h.settleNext(); // enable #1 lands — for generation 1, not this one
    expect(h.feature.access.current()).toBeNull();
    expect(h.calls.map((c) => c.kind)).toEqual(["enable", "disable"]);
    await h.settleNext(); // the disable lands — generation 2
    expect(h.feature.access.current()).toBeNull();
    expect(h.calls.map((c) => c.kind)).toEqual(["enable", "disable", "enable"]);
    await h.settleNext(); // enable #3 — this generation's
    expect(h.feature.access.current()).not.toBeNull();
    expect(h.registry.has("task.create")).toBe(true);
  });

  it("Off saves a board whose last write failed before the store closes, then lets the owner go", async () => {
    const h = setup();
    await h.setTasks(true);
    await h.settleNext();
    const owner = h.feature.access.current()!;
    h.store.failNextWrite("disk full");
    const held = await owner.create("ws-1", { teamId: "team-1", title: "dirty" }, USER_ACTOR);
    expect(held.ok && held.saved).toBe(false);
    expect(h.store.files.get("ws-1")).toBeUndefined();
    await h.setTasks(false);
    expect(h.feature.access.current()).toBeNull();
    // The disable's flush wrote the board BEFORE the store was told to close.
    expect(h.store.files.get("ws-1")).toBeDefined();
    expect(h.calls.map((c) => c.kind)).toEqual(["enable", "disable"]);
    expect(h.order).toEqual(["write", "disable"]);
  });

  it("On, Off, On in one turn: the first enable carries the first generation and its answer opens nothing", async () => {
    const h = setup();
    // Three changes before any backend call starts.
    h.setTasksSync(true);
    h.setTasksSync(false);
    h.setTasksSync(true);
    await flush();
    expect(h.calls.map((c) => c.kind)).toEqual(["enable"]);
    await h.settleNext(); // enable #1 — queued for generation 1
    expect(h.feature.access.current()).toBeNull();
    expect(h.registry.has("task.create")).toBe(false);
    await h.settleNext(); // the disable
    await h.settleNext(); // enable #3
    expect(h.feature.access.current()).not.toBeNull();
    expect(h.registry.has("task.create")).toBe(true);
  });

  it("an Off over a board the disk refuses is refused itself: the owner is held with its board, an On takes it back, and the next Off writes and closes", async () => {
    const h = setup();
    await h.setTasks(true);
    await h.settleNext();
    const service = h.feature.access.current()!;
    h.setDiskFull(true);
    const created = await service.create("ws-1", { teamId: "team-1", title: "a" }, USER_ACTOR);
    expect(created.ok && created.saved).toBe(false);

    await h.setTasks(false);
    await flush();
    await flush();
    // Refused: the store was not told to close, the status says why by
    // the workspace's name, and the surfaces read Off.
    expect(h.calls.map((c) => c.kind)).toEqual(["enable"]);
    expect(h.status.last()).toEqual({ desired: false, ok: false, detail: "keepdeck's board — disk full" });
    expect(h.feature.access.current()).toBeNull();
    expect(h.store.files.has("ws-1")).toBe(false);

    // On takes the held owner back — the same one, its board still whole
    // and still marked.
    await h.setTasks(true);
    await h.settleNext();
    const back = h.feature.access.current();
    expect(back).toBe(service);
    const state = back!.peek("ws-1");
    expect(state?.kind === "ready" && state.unsaved).toBe("disk full");
    expect(state?.kind === "ready" && state.board.tasks.map((t) => t.title)).toEqual(["a"]);
    expect(h.registry.has("task.create")).toBe(true);

    // The disk frees: this Off writes the board, then closes the store.
    h.setDiskFull(false);
    await h.setTasks(false);
    await flush();
    await flush();
    expect(h.order).toEqual(["write", "disable"]);
    expect((JSON.parse(h.store.files.get("ws-1")!) as { tasks: { title: string }[] }).tasks.map((t) => t.title)).toEqual(["a"]);
    await h.settleNext();
    expect(h.status.last()).toEqual({ desired: false, ok: true, detail: null });
  });

  it("a refused Off completes on its own once the held owner's retry lands the board", async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      const tick = () => vi.advanceTimersByTimeAsync(0);
      const settle = async (index: number) => {
        h.calls[index].settled = true;
        h.calls[index].gate.resolve();
        await tick();
      };
      h.setTasksSync(true);
      await tick();
      await settle(0);
      const service = h.feature.access.current()!;
      h.setDiskFull(true);
      await service.create("ws-1", { teamId: "team-1", title: "a" }, USER_ACTOR);
      h.setTasksSync(false);
      await tick();
      await tick();
      expect(h.calls.map((c) => c.kind)).toEqual(["enable"]);
      expect(h.status.last()?.ok).toBe(false);

      // The disk frees before anyone touches a setting: the owner's own
      // retry lands the board, and that is the Off's cue.
      h.setDiskFull(false);
      await vi.advanceTimersByTimeAsync(RETRY_WRITE_MS);
      await tick();
      await tick();
      expect(h.order).toEqual(["write", "disable"]);
      expect(h.calls.map((c) => c.kind)).toEqual(["enable", "disable"]);
      await settle(1);
      expect(h.status.last()).toEqual({ desired: false, ok: true, detail: null });
      expect((JSON.parse(h.store.files.get("ws-1")!) as { tasks: unknown[] }).tasks).toHaveLength(1);
      h.feature.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a workspace closing while the retiring owner flushes reaches that owner: no write after the drop, the store closes after both, the id's new life is empty", async () => {
    const h = setup();
    await h.setTasks(true);
    await h.settleNext();
    const service = h.feature.access.current()!;
    await service.ready("ws-1");
    const release = h.store.holdNextWrite();
    const first = service.create("ws-1", { teamId: "team-1", title: "a" }, USER_ACTOR);
    await flush();
    const second = service.create("ws-1", { teamId: "team-1", title: "b" }, USER_ACTOR);
    await flush();
    // Off: the owner retires and the disable is in its flush, waiting on
    // the held write — the store has not been told to close.
    await h.setTasks(false);
    expect(h.feature.access.current()).toBeNull();
    expect(h.calls.map((c) => c.kind)).toEqual(["enable"]);

    const forgetting = h.feature.forgetWorkspace("ws-1");
    release();
    await forgetting;
    await Promise.all([first, second]);
    await flush();
    await flush();
    expect(h.store.calls).toEqual(["write", "drop"]);
    expect(h.order).toEqual(["write", "drop", "disable"]);
    expect(h.store.files.has("ws-1")).toBe(false);
    await h.settleNext();

    await h.setTasks(true);
    await h.settleNext();
    expect(await h.feature.access.current()!.ready("ws-1")).toEqual({ kind: "ready", board: { nextId: 1, tasks: [] }, unsaved: null });
  });

  it("forgets a workspace through the owner — after the write on the wire, before nothing else; dispose takes the owner and the commands down", async () => {
    const h = setup();
    await h.setTasks(true);
    await h.settleNext();
    const service = h.feature.access.current()!;
    await service.ready("ws-1");
    const release = h.store.holdNextWrite();
    const first = service.create("ws-1", { teamId: "team-1", title: "a" }, USER_ACTOR);
    await flush();
    const second = service.create("ws-1", { teamId: "team-1", title: "b" }, USER_ACTOR);
    await flush();
    let forgotten = false;
    const forgetting = h.feature.forgetWorkspace("ws-1").then(() => {
      forgotten = true;
    });
    await flush();
    // The first write's bytes are down, its answer is not: the forget
    // waits on it, and the backend has seen no drop.
    expect(forgotten).toBe(false);
    expect(h.store.calls).toEqual(["write"]);
    expect(h.order).toEqual([]);
    release();
    await forgetting;
    await Promise.all([first, second]);
    expect(h.order).toEqual(["write", "drop"]);
    expect(h.store.files.has("ws-1")).toBe(false);
    expect(h.feature.access.current()).not.toBeNull();
    h.feature.dispose();
    expect(h.feature.access.current()).toBeNull();
    expect(h.registry.has("task.create")).toBe(false);
    // Dispose closes nothing: the store's life is the setting's.
    expect(h.calls.map((c) => c.kind)).toEqual(["enable"]);
  });
});
