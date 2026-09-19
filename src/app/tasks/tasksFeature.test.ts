import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "../../domain/commands";
import { createEnableStatus } from "../enableStatus";
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
        return store.port.write(args);
      },
      enable: () => {
        const g = gate();
        calls.push({ kind: "enable", gate: g, settled: false });
        return g.promise.then(() => {
          open = true;
        });
      },
      disable: () => {
        const g = gate();
        calls.push({ kind: "disable", gate: g, settled: false });
        return g.promise.then(() => {
          open = false;
        });
      },
      dropWorkspace: vi.fn(async () => {}),
    },
    announce: (event) => announced.push(event),
    status: createEnableStatus(),
  });
  return {
    feature,
    registry,
    announced,
    calls,
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

  it("forgets a workspace here and drops it on disk; dispose takes the owner and the commands down", async () => {
    const h = setup();
    await h.setTasks(true);
    await h.settleNext();
    await h.feature.forgetWorkspace("ws-1");
    expect(h.feature.access.current()).not.toBeNull();
    h.feature.dispose();
    expect(h.feature.access.current()).toBeNull();
    expect(h.registry.has("task.create")).toBe(false);
    // Dispose closes nothing: the store's life is the setting's.
    expect(h.calls.map((c) => c.kind)).toEqual(["enable"]);
  });
});
