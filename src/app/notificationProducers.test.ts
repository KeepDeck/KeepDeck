import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import {
  initActivityNotifications,
  initUpdateNotifications,
  notifyAgentCrashed,
  notifyAgentSpawnFailed,
  pluginNotificationSource,
  resetUpdateNotifications,
} from "./notificationProducers";
import { createAgentStatusTracker } from "./agentStatusTracker";

const center = vi.hoisted(() => ({
  notify: vi.fn(),
}));
vi.mock("./notificationCenter", () => center);

const settings = vi.hoisted(() => ({
  enabled: true,
}));
vi.mock("./settingsManager", () => ({
  getSettings: () => ({
    notifications: { enabled: settings.enabled, mode: "system-and-app", mutedPlugins: [] },
  }),
}));

const updates = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: { phase: "idle", version: null as string | null },
    subscribeUpdates: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getUpdateState: () => updates.state,
    fire(phase: string, version: string | null) {
      updates.state = { phase, version };
      for (const listener of [...listeners]) listener();
    },
  };
});
vi.mock("./updateManager", () => ({
  subscribeUpdates: updates.subscribeUpdates,
  getUpdateState: updates.getUpdateState,
}));

const agents = [
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    features: [],
    installed: true,
    path: null,
  },
];
const workspaceInstance = createWorkspaceInstance();

function deckWith(paneName?: string): Workspace[] {
  return [
    {
      id: "ws-1",
      instance: workspaceInstance,
      name: "Alpha",
      cwd: "/repo",
      panes: [
        {
          id: "pane-1",
          agentType: "claude",
          ...(paneName !== undefined ? { name: paneName } : {}),
        },
      ],
    } as unknown as Workspace,
  ];
}

describe("pane producers", () => {
  beforeEach(() => center.notify.mockClear());

  it("crash: titles by the pane's display title, tags by the pane", () => {
    notifyAgentCrashed(deckWith(), "ws-1", "pane-1", 137, agents);
    expect(center.notify).toHaveBeenCalledWith({
      title: "Claude 1 crashed",
      body: "Exit code 137 · Alpha",
      severity: "error",
      source: {
        type: "pane",
        workspace: { id: "ws-1", instance: workspaceInstance },
        paneId: "pane-1",
      },
      tag: "pane:pane-1:crash",
    });
  });

  it("crash: a null code reads as terminated; manual names win the title", () => {
    notifyAgentCrashed(deckWith("builder"), "ws-1", "pane-1", null, agents);
    expect(center.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "builder crashed",
        body: "Terminated · Alpha",
      }),
    );
  });

  it("crash: silent when the pane is already gone", () => {
    notifyAgentCrashed(deckWith(), "ws-1", "missing", 1, agents);
    notifyAgentCrashed([], "ws-1", "pane-1", 1, agents);
    expect(center.notify).not.toHaveBeenCalled();
  });

  it("spawn failure carries the message", () => {
    notifyAgentSpawnFailed(deckWith(), "ws-1", "pane-1", "ENOENT", agents);
    expect(center.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Claude 1 failed to start",
        body: "ENOENT · Alpha",
        tag: "pane:pane-1:spawn",
      }),
    );
  });
});

describe("plugin notification source", () => {
  it("captures the current workspace lifetime", () => {
    expect(
      pluginNotificationSource(
        "git",
        { id: "ws-1", instance: workspaceInstance },
        "changes",
      ),
    ).toEqual({
      type: "plugin",
      pluginId: "git",
      workspace: { id: "ws-1", instance: workspaceInstance },
      dockTab: "changes",
    });
  });

  it("preserves a stale lifetime instead of resolving by reusable id", () => {
    expect(
      pluginNotificationSource("git", {
        id: "ws-1",
        instance: workspaceInstance,
      }),
    ).toEqual({
      type: "plugin",
      pluginId: "git",
      workspace: { id: "ws-1", instance: workspaceInstance },
    });
  });
});

describe("update producer", () => {
  beforeEach(() => {
    center.notify.mockClear();
    settings.enabled = true;
    resetUpdateNotifications();
  });

  it("a version found while notifications are off is announced after re-enabling", () => {
    const stop = initUpdateNotifications();
    settings.enabled = false;
    updates.fire("available", "1.2.3");
    expect(center.notify).not.toHaveBeenCalled();

    // Re-enabled: the version was NOT burned as announced — the next check
    // (periodic or manual) surfaces it.
    settings.enabled = true;
    updates.fire("available", "1.2.3");
    expect(center.notify).toHaveBeenCalledTimes(1);
    stop();
  });

  it("announces a found version once across repeated checks", () => {
    const stop = initUpdateNotifications();
    updates.fire("available", "1.2.3");
    updates.fire("idle", null); // dismissed
    updates.fire("available", "1.2.3"); // 4-hourly re-check finds it again
    expect(center.notify).toHaveBeenCalledTimes(1);
    expect(center.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "KeepDeck 1.2.3 is available",
        source: { type: "app" },
        tag: "app:update",
      }),
    );
    stop();
  });

  it("a newer version is news again", () => {
    const stop = initUpdateNotifications();
    updates.fire("available", "1.2.3");
    updates.fire("available", "1.3.0");
    expect(center.notify).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ignores every other phase", () => {
    const stop = initUpdateNotifications();
    updates.fire("checking", null);
    updates.fire("downloading", "1.2.3");
    expect(center.notify).not.toHaveBeenCalled();
    stop();
  });
});

describe("activity notifications", () => {
  const edgeNormalizer = (payload: unknown) =>
    (payload as { edge?: import("@keepdeck/plugin-api").AgentStatusEvent })
      .edge ?? null;
  let tracker: ReturnType<typeof createAgentStatusTracker>;
  let stop: () => void;

  beforeEach(() => {
    center.notify.mockClear();
    // The factory's whole point: each test builds its own tracker.
    tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", edgeNormalizer);
    stop = initActivityNotifications(tracker, () => ({
      workspaces: deckWith(),
      agents,
    }));
  });

  afterEach(() => stop());

  const edge = (e: Record<string, unknown>) =>
    tracker.report("pane-1", { agent: "claude", edge: e });

  it("announces a wait once — re-assertions do not stack banners", () => {
    edge({ kind: "waiting", at: 100, reason: "permission" });
    expect(center.notify).toHaveBeenCalledWith({
      title: "Claude 1 — needs approval",
      body: "Alpha",
      severity: "warning",
      source: {
        type: "pane",
        workspace: { id: "ws-1", instance: workspaceInstance },
        paneId: "pane-1",
      },
      tag: "pane:pane-1:activity",
    });
    edge({ kind: "waiting", at: 200, reason: "question" });
    expect(center.notify).toHaveBeenCalledTimes(1);
  });

  it("announces a finished turn, but never one the user cut themselves", () => {
    edge({ kind: "turn-start", at: 100 });
    edge({ kind: "turn-end", at: 200 });
    expect(center.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Claude 1 finished",
        body: "Alpha",
        tag: "pane:pane-1:activity",
      }),
    );

    center.notify.mockClear();
    edge({ kind: "turn-start", at: 300 });
    edge({ kind: "interrupted", at: 400 });
    expect(center.notify).not.toHaveBeenCalled();
  });

  it("a done with no running turn behind it announces nothing", () => {
    edge({ kind: "turn-end", at: 100 });
    expect(center.notify).not.toHaveBeenCalled();
  });

  it("announces a failed turn with its prose", () => {
    edge({ kind: "turn-start", at: 100 });
    center.notify.mockClear();
    edge({
      kind: "turn-failed",
      at: 200,
      error: "rate_limit",
      detail: "Weekly limit reached",
    });
    expect(center.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Claude 1 — rate limited",
        body: "Weekly limit reached · Alpha",
        severity: "error",
      }),
    );
  });

  it("stays silent for a pane the deck no longer names", () => {
    stop();
    stop = initActivityNotifications(tracker, () => ({
      workspaces: [],
      agents,
    }));
    edge({ kind: "waiting", at: 100, reason: "permission" });
    expect(center.notify).not.toHaveBeenCalled();
  });
});
