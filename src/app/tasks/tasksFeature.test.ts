import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../domain/commands";
import { createEnableStatus } from "../enableStatus";
import { USER_ACTOR } from "../../domain/tasks";
import { createTasksFeature } from "./tasksFeature";
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
  // Unknown until the settings load, as at boot: the policy waits for a value.
  let tasks: boolean | null = null;
  let socket = true;
  const settingsListeners = new Set<() => void>();
  const socketListeners = new Set<() => void>();
  /** Enable/disable calls, each waiting on its own gate, in order. */
  const calls: { kind: "enable" | "disable"; gate: ReturnType<typeof gate>; settled: boolean }[] = [];
  const registry = createCommandRegistry();
  const announced: unknown[] = [];
  /** Writes, drops and disables, in the order the backend saw them. */
  const order: ("write" | "drop" | "disable")[] = [];
  const feature = createTasksFeature({
    registry,
    workspaces: () => teamedWorkspaces(),
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
    status: createEnableStatus(),
  });
  return {
    feature,
    registry,
    announced,
    calls,
    store,
    order,
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
