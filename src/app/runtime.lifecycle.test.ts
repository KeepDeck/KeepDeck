import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadBackend } from "./downloadManager";
import { createCommandRegistry } from "../domain/commands";
import { serializeDeck } from "../domain/deck";
import { emptyJournal } from "../domain/journal";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Versioned } from "../ipc/generated/lifecycle/Versioned";
import { standingNotice } from "../presentation/lifecycleWords";
import { getNotifications } from "./notificationCenter";
import { createAppRuntime } from "./runtime";

/**
 * The runtime and the lifecycle machine, at the IPC seam (integration rows
 * B6, B7 and B14): the subscription is registered before the handshake, the
 * handshake hands the deck as it loaded, a snapshot's deck command reaches
 * the deck once and is reported applied, and every save says its revision.
 */

const machine = vi.hoisted(() => {
  const order: string[] = [];
  let hear: ((heard: unknown) => void) | null = null;
  return {
    order,
    push: (versioned: unknown) => hear?.({ kind: "snapshot", versioned }),
    stop: () => hear?.({ kind: "stopped" }),
    subscribeLifecycle: vi.fn(async (onHeard: (heard: unknown) => void) => {
      order.push("subscribe");
      hear = onHeard;
    }),
    onLifecycleRestarted: vi.fn(async () => () => {}),
    bootHandshake: vi.fn(async (..._args: unknown[]) => {
      order.push("handshake");
      return { kind: "answered", answer: { kind: "done" } };
    }),
    reportApplied: vi.fn(async (..._args: unknown[]) => {}),
    reportDeckSaved: vi.fn(async (..._args: unknown[]) => {}),
    reportHookEnded: vi.fn(async () => {}),
    sendIntent: vi.fn(async () => ({ kind: "unavailable" })),
    askLease: vi.fn(async () => ({ kind: "unavailable" })),
    releaseLease: vi.fn(async () => {}),
    previewIntent: vi.fn(),
    claimsOn: vi.fn(async () => []),
    locationFor: vi.fn(),
  };
});
vi.mock("../ipc/lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/lifecycle")>()),
  ...machine,
}));

const STORED = JSON.stringify({
  version: 11,
  minVersion: 11,
  activeId: "ws-a",
  focusByWs: {},
  selectByWs: {},
  workspaces: [
    {
      id: "ws-a",
      name: "web",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        { id: "pane-1", agentType: "claude" },
        { id: "pane-2", agentType: "claude" },
      ],
    },
  ],
});

const disk = vi.hoisted(() => ({
  loadDeckState: vi.fn(async (): Promise<string | null> => null),
  saveDeckState: vi.fn(async (_json: string) => {}),
  quarantineDeckState: vi.fn(async () => {}),
}));
vi.mock("../ipc/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/state")>()),
  ...disk,
}));

const plans = vi.hoisted(() => ({ dropPaneSpawnSpec: vi.fn((_pane: string) => {}) }));
vi.mock("./spawnSpecs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spawnSpecs")>()),
  ...plans,
}));

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function backend(): DownloadBackend {
  return {
    start: vi.fn(async () => new Promise<void>(() => {})),
    cancel: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  };
}

/** A snapshot owing the deck one command: pane-2 goes. */
const removePane2: Versioned = {
  version: 1,
  snapshot: {
    open: true,
    viewOnly: false,
    sessionsDown: false,
    forgotten: { workspaces: [], teams: [], panes: ["pane-2"] },
    workspaces: {},
    teams: {},
    gates: {},
    panes: {},
    commands: [{ id: { op: 2, index: 1 }, owner: "deck", cmd: { kind: "removePane", workspace: "ws-a", pane: "pane-2" } }],
  },
};

describe("the runtime and the lifecycle machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    machine.order.length = 0;
  });

  it("registers the subscription before the handshake, and hands the machine the deck as it loaded", async () => {
    disk.loadDeckState.mockResolvedValueOnce(STORED);
    const runtime = createAppRuntime(backend(), createCommandRegistry());
    await vi.waitFor(() => expect(machine.bootHandshake).toHaveBeenCalled());

    expect(machine.order.indexOf("subscribe")).toBeGreaterThanOrEqual(0);
    expect(machine.order.indexOf("subscribe")).toBeLessThan(machine.order.indexOf("handshake"));
    const [facts, load] = machine.bootHandshake.mock.calls[0];
    expect(load).toBe("loaded");
    expect(JSON.stringify(facts)).toContain("pane-2");
    runtime.dispose();
  });

  it("carries a snapshot's deck command into the deck once, reports it applied, and says the revision it saved", async () => {
    disk.loadDeckState.mockResolvedValueOnce(STORED);
    const runtime = createAppRuntime(backend(), createCommandRegistry());
    await vi.waitFor(() => expect(machine.bootHandshake).toHaveBeenCalled());

    machine.push(removePane2);
    machine.push(removePane2);
    await vi.waitFor(() => expect(machine.reportApplied).toHaveBeenCalled());
    await settled();

    const panes = runtime.deckStore.getSnapshot().workspaces[0].panes.map((pane) => pane.id);
    expect(panes).toEqual(["pane-1"]);
    expect(machine.reportApplied).toHaveBeenCalledTimes(1);
    expect(machine.reportApplied.mock.calls[0][0]).toEqual({ op: 2, index: 1 });

    await vi.waitFor(() => expect(machine.reportDeckSaved).toHaveBeenCalled());
    expect(machine.reportDeckSaved).toHaveBeenLastCalledWith(runtime.deckStore.revision());
    runtime.dispose();
  });

  /** Integration row B24: a pane's launch state ends by the machine's
   * command, before the stop it precedes — one facade, not a drop on every
   * lifecycle path of the page's own. */
  it("ends a pane's launch plan when the machine retires it, and reports it applied", async () => {
    disk.loadDeckState.mockResolvedValueOnce(STORED);
    const runtime = createAppRuntime(backend(), createCommandRegistry());
    await vi.waitFor(() => expect(machine.bootHandshake).toHaveBeenCalled());
    machine.reportApplied.mockClear();

    machine.push({
      version: 2,
      snapshot: {
        ...removePane2.snapshot,
        forgotten: { workspaces: [], teams: [], panes: [] },
        commands: [{ id: { op: 3, index: 0 }, owner: "runState", cmd: { kind: "retire", workspace: "ws-a", pane: "pane-2" } }],
      },
    });
    await vi.waitFor(() => expect(machine.reportApplied).toHaveBeenCalled());

    expect(plans.dropPaneSpawnSpec).toHaveBeenCalledWith("pane-2");
    expect(machine.reportApplied.mock.calls[0][0]).toEqual({ op: 3, index: 0 });
    runtime.dispose();
  });

  /** Integration row B22: the folder-gone card's "start fresh" moves the
   * member to the root's team — an intent the machine carries out, never a
   * deck write of the page's own. */
  it("asks the machine to relocate a member onto the root's team, and leaves the deck to its commands", async () => {
    const teamed = serializeDeck({
      workspaces: [
        {
          id: "ws-a",
          instance: createWorkspaceInstance(),
          name: "web",
          cwd: "/repo",
          worktreeBaseDir: "/wt",
          teams: [
            { id: "team-r", name: "root", location: { kind: "attached", cwd: "/repo" } },
            { id: "team-1", name: "api", location: { kind: "attached", cwd: "/wt/gone" } },
          ],
          panes: [
            { id: "pane-1", agentType: "claude", team: { teamId: "team-r", role: "lead" } },
            { id: "pane-2", agentType: "claude", team: { teamId: "team-1", role: "lead" } },
          ],
        },
      ],
      activeId: "ws-a",
      viewByWs: {},
      journal: emptyJournal,
    });
    disk.loadDeckState.mockResolvedValueOnce(teamed);
    const runtime = createAppRuntime(backend(), createCommandRegistry());
    await vi.waitFor(() => expect(machine.bootHandshake).toHaveBeenCalled());
    const before = runtime.deckStore.getSnapshot().workspaces;

    runtime.orchestrator.startFresh("ws-a", "pane-2", "reviewer");
    await vi.waitFor(() => expect(machine.sendIntent).toHaveBeenCalled());

    expect(machine.sendIntent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "relocate", workspace: "ws-a", pane: "pane-2", root: "team-r" }),
    );
    expect(runtime.deckStore.getSnapshot().workspaces).toBe(before);
    runtime.dispose();
  });

  /** v26 §13, "the machine fell": the screen says nothing starts or closes
   * until KeepDeck restarts — once, however often the channel says it. */
  it("tells the person once that the machine stopped", async () => {
    const runtime = createAppRuntime(backend(), createCommandRegistry());
    await vi.waitFor(() => expect(machine.subscribeLifecycle).toHaveBeenCalled());
    const said = () => getNotifications().filter((notice) => notice.title === standingNotice("stopped").title);
    expect(said()).toHaveLength(0);
    machine.stop();
    machine.stop();
    expect(said()).toHaveLength(1);
    runtime.dispose();
  });
});
