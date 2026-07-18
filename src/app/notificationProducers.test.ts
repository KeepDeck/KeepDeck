import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import {
  initUpdateNotifications,
  notifyAgentCrashed,
  notifyAgentSpawnFailed,
  pluginNotificationSource,
  resetUpdateNotifications,
} from "./notificationProducers";

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
  { id: "claude", label: "Claude", command: "claude", supportsYolo: false, installed: true, path: null, reportsUsage: true },
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
