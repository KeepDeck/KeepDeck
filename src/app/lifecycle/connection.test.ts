import { describe, expect, it, vi } from "vitest";
import type { DeckLoad } from "../../domain/lifecycle";
import type { Workspace } from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { versioned } from "../../ipc/generated/lifecycle/examples";
import type { Reply } from "../../ipc/generated/lifecycle/Reply";
import { connectLifecycle, type LifecycleConnectionPorts } from "./connection";

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const BOOTED: Reply = { kind: "answered", answer: { kind: "booted", finishing: [] } };

const ws: Workspace = { id: "ws-a", instance: createWorkspaceInstance(), name: "web", cwd: "/repo", worktreeBaseDir: null, panes: [] };

function rig() {
  const order: string[] = [];
  let restart: (() => void) | null = null;
  let loaded: { workspaces: readonly Workspace[]; load: DeckLoad } | null = null;
  const loadListeners = new Set<() => void>();
  const ports = {
    subscribe: vi.fn<LifecycleConnectionPorts["subscribe"]>(async () => {
      order.push("subscribe");
    }),
    onRestarted: vi.fn<LifecycleConnectionPorts["onRestarted"]>(async (handler) => {
      restart = handler;
      return () => {};
    }),
    handshake: vi.fn<LifecycleConnectionPorts["handshake"]>(async () => {
      order.push("handshake");
      return BOOTED;
    }),
  };
  const snapshot = { receive: vi.fn(), restarted: vi.fn() };
  const warn = vi.fn();
  const booted = vi.fn();
  const stopped = vi.fn();
  const connection = connectLifecycle({
    ports,
    snapshot,
    loaded: () => loaded,
    subscribeLoaded: (listener) => {
      loadListeners.add(listener);
      return () => loadListeners.delete(listener);
    },
    booted,
    stopped,
    warn,
  });
  return {
    order,
    ports,
    snapshot,
    warn,
    booted,
    stopped,
    connection,
    load(load: DeckLoad) {
      loaded = { workspaces: [ws], load };
      for (const listener of [...loadListeners]) listener();
    },
    restart: () => restart?.(),
  };
}

describe("connectLifecycle", () => {
  it("subscribes first, then hands over the deck only once it has loaded, and how", async () => {
    const r = rig();
    await settled();
    expect(r.order).toEqual(["subscribe"]);
    expect(r.ports.handshake).not.toHaveBeenCalled();

    r.load("quarantined");
    await settled();
    expect(r.order).toEqual(["subscribe", "handshake"]);
    const [facts, load] = r.ports.handshake.mock.calls[0];
    expect(load).toBe("quarantined");
    expect(facts.workspaces.map((w) => w.id)).toEqual(["ws-a"]);
  });

  it("hands every snapshot to the store, and none after it is disposed", async () => {
    const r = rig();
    await settled();
    const push = r.ports.subscribe.mock.calls[0][0];
    push({ kind: "snapshot", versioned });
    expect(r.snapshot.receive).toHaveBeenCalledWith(versioned);
    r.connection.dispose();
    push({ kind: "snapshot", versioned: { ...versioned, version: versioned.version + 1 } });
    expect(r.snapshot.receive).toHaveBeenCalledTimes(1);
  });

  it("says the machine stopped when its channel says so, and takes nothing for a snapshot", async () => {
    const r = rig();
    await settled();
    const push = r.ports.subscribe.mock.calls[0][0];
    push({ kind: "stopped" });
    expect(r.stopped).toHaveBeenCalledTimes(1);
    expect(r.snapshot.receive).not.toHaveBeenCalled();
  });

  it("starts over with a machine that started over: subscribe and handshake again, versions from the start", async () => {
    const r = rig();
    r.load("loaded");
    await settled();
    r.restart();
    await settled();
    expect(r.snapshot.restarted).toHaveBeenCalledTimes(1);
    expect(r.order).toEqual(["subscribe", "handshake", "subscribe", "handshake"]);
    // Each machine that took the handshake is said to be up — the cue to
    // tell it again what is on disk.
    expect(r.booted).toHaveBeenCalledTimes(2);
  });

  it("says a handshake that got no answer, or a refusal — nothing else stands in for it", async () => {
    const r = rig();
    r.ports.handshake.mockResolvedValueOnce({ kind: "unavailable" });
    r.load("loaded");
    await settled();
    expect(r.warn).toHaveBeenCalledWith(expect.stringContaining("no answer"));
    expect(r.booted).not.toHaveBeenCalled();
  });
});
