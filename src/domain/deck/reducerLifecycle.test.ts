import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../workspaceInstance";
import { deckReducer, initialDeckState } from "./reducer";
import { deckState as state, workspace as ws } from "./reducer.testSupport";
import type { Workspace } from "./workspaces";

describe("deckReducer restore actions ([F7])", () => {
  const idleWs: Workspace = {
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "ws-1",
    cwd: "/tmp",
    worktreeBaseDir: null,
    panes: [
      { id: "pane-1", idle: { reason: "waking", origin: "restore" } },
      { id: "pane-2" },
    ],
  };

  it("hydrates deck-owned state while preserving the journal", () => {
    const restored = state({ workspaces: [idleWs], activeId: "ws-1" });
    const hydrated = deckReducer(initialDeckState, {
      type: "hydrate",
      state: restored,
    });
    expect(hydrated.workspaces).toBe(restored.workspaces);
    expect(hydrated.activeId).toBe(restored.activeId);
    expect(hydrated.viewByWs).toBe(restored.viewByWs);
    expect(hydrated.journal).toBe(initialDeckState.journal);
  });

  it("rejects duplicate workspace ids during hydrate", () => {
    const current = state({ workspaces: [idleWs], activeId: "ws-1" });
    const duplicate = state({
      workspaces: [idleWs, ws("ws-1", ["another-pane"])],
      activeId: "ws-1",
    });
    expect(deckReducer(current, { type: "hydrate", state: duplicate })).toBe(
      current,
    );
  });

  it("clears an idle marker", () => {
    const start = state({ workspaces: [idleWs], activeId: "ws-1" });
    const next = deckReducer(start, {
      type: "clearPaneIdle",
      wsId: "ws-1",
      paneId: "pane-1",
    });
    expect(next.workspaces[0].panes[0]).toEqual({ id: "pane-1" });
  });

  it("preserves identity when clearing a live or unknown pane", () => {
    const start = state({ workspaces: [idleWs], activeId: "ws-1" });
    expect(
      deckReducer(start, {
        type: "clearPaneIdle",
        wsId: "ws-1",
        paneId: "pane-2",
      }),
    ).toBe(start);
    expect(
      deckReducer(start, {
        type: "clearPaneIdle",
        wsId: "ws-1",
        paneId: "nope",
      }),
    ).toBe(start);
  });

  it("suspends a live pane without changing its placement by default", () => {
    const next = deckReducer(state({ workspaces: [idleWs], activeId: "ws-1" }), {
      type: "suspendPane",
      wsId: "ws-1",
      paneId: "pane-2",
      at: "2026-07-25T10:00:00.000Z",
    });
    expect(next.workspaces[0].panes[1]).toEqual({
      id: "pane-2",
      idle: { reason: "suspended", at: "2026-07-25T10:00:00.000Z" },
    });
    expect(next.viewByWs).toEqual({});
  });

  it("atomically records and restores suspended Tray placement", () => {
    const suspended = deckReducer(
      state({
        workspaces: [idleWs],
        activeId: "ws-1",
        viewByWs: {
          "ws-1": { focus: "pane-2", select: "pane-2" },
        },
      }),
      {
        type: "suspendPane",
        wsId: "ws-1",
        paneId: "pane-2",
        at: "2026-07-25T10:00:00.000Z",
        moveToTray: true,
      },
    );
    expect(suspended.workspaces[0].panes[1].idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T10:00:00.000Z",
    });
    expect(suspended.viewByWs).toEqual({
      "ws-1": { select: "pane-1", suspendedTray: ["pane-2"] },
    });

    const restored = deckReducer(suspended, {
      type: "restoreSuspendedPane",
      wsId: "ws-1",
      paneId: "pane-2",
    });
    expect(restored.viewByWs).toEqual({
      "ws-1": { select: "pane-2" },
    });
    expect(restored.workspaces[0].panes[1].idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T10:00:00.000Z",
    });
  });

  it("keeps the minimized set distinct from suspended Tray placement", () => {
    const next = deckReducer(
      state({
        workspaces: [idleWs],
        activeId: "ws-1",
        viewByWs: {
          "ws-1": { select: "pane-2", minimized: ["pane-2"] },
        },
      }),
      {
        type: "suspendPane",
        wsId: "ws-1",
        paneId: "pane-2",
        at: "2026-07-25T10:00:00.000Z",
        moveToTray: true,
      },
    );
    expect(next.viewByWs).toEqual({
      "ws-1": {
        select: "pane-1",
        minimized: ["pane-2"],
        suspendedTray: ["pane-2"],
      },
    });
  });

  it("repairs a selection against BOTH hidden sets when a pane joins the tray", () => {
    // A minimized pane is off the grid as surely as a suspended one, so a
    // selection stranded on it does not survive the transition; with nothing
    // left on the grid there is no pane to move it to.
    const next = deckReducer(
      state({
        workspaces: [idleWs],
        activeId: "ws-1",
        viewByWs: {
          "ws-1": { select: "pane-1", minimized: ["pane-1"] },
        },
      }),
      {
        type: "suspendPane",
        wsId: "ws-1",
        paneId: "pane-2",
        at: "2026-07-25T10:00:00.000Z",
        moveToTray: true,
      },
    );
    expect(next.viewByWs["ws-1"]).toEqual({
      minimized: ["pane-1"],
      suspendedTray: ["pane-2"],
    });
  });

  it("restores only Tray placement when the pane is also manually minimized", () => {
    const start = state({
      workspaces: [idleWs],
      activeId: "ws-1",
      viewByWs: {
        "ws-1": {
          select: "pane-1",
          minimized: ["pane-2"],
          suspendedTray: ["pane-2"],
        },
      },
    });
    const restored = deckReducer(start, {
      type: "restoreSuspendedPane",
      wsId: "ws-1",
      paneId: "pane-2",
    });
    expect(restored.viewByWs["ws-1"]).toEqual({
      select: "pane-1",
      minimized: ["pane-2"],
    });
  });

  it("does not suspend an unknown pane", () => {
    const start = state({ workspaces: [idleWs], activeId: "ws-1" });
    expect(
      deckReducer(start, {
        type: "suspendPane",
        wsId: "ws-1",
        paneId: "nope",
        at: "2026-07-25T10:00:00.000Z",
      }),
    ).toBe(start);
  });

  it("hands a suspended pane to the sweep as a manual wake", () => {
    const suspended = deckReducer(
      state({ workspaces: [idleWs], activeId: "ws-1" }),
      {
        type: "suspendPane",
        wsId: "ws-1",
        paneId: "pane-2",
        at: "2026-07-25T10:00:00.000Z",
      },
    );
    const woken = deckReducer(suspended, {
      type: "requestPaneWake",
      wsId: "ws-1",
      paneId: "pane-2",
    });
    expect(woken.workspaces[0].panes[1]).toEqual({
      id: "pane-2",
      idle: {
        reason: "waking",
        origin: "manual",
        from: { reason: "suspended", at: "2026-07-25T10:00:00.000Z" },
      },
    });
  });

  it("does not wake a live or unknown pane", () => {
    const start = state({ workspaces: [idleWs], activeId: "ws-1" });
    expect(
      deckReducer(start, {
        type: "requestPaneWake",
        wsId: "ws-1",
        paneId: "pane-2",
      }),
    ).toBe(start);
    expect(
      deckReducer(start, {
        type: "requestPaneWake",
        wsId: "ws-1",
        paneId: "nope",
      }),
    ).toBe(start);
  });

  it("returns failed manual wakes to their original idle state", () => {
    const suspended = deckReducer(
      state({ workspaces: [idleWs], activeId: "ws-1" }),
      {
        type: "suspendPane",
        wsId: "ws-1",
        paneId: "pane-2",
        at: "2026-07-25T10:00:00.000Z",
      },
    );
    const waking = deckReducer(suspended, {
      type: "requestPaneWake",
      wsId: "ws-1",
      paneId: "pane-2",
    });
    const failed = deckReducer(waking, {
      type: "failPaneWake",
      wsId: "ws-1",
      paneId: "pane-2",
    });
    expect(failed.workspaces[0].panes[1].idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T10:00:00.000Z",
    });

    const asked = deckReducer(failed, {
      type: "requestPaneWake",
      wsId: "ws-1",
      paneId: "pane-1",
    });
    expect(
      deckReducer(asked, {
        type: "failPaneWake",
        wsId: "ws-1",
        paneId: "pane-1",
      }).workspaces[0].panes[0].idle,
    ).toEqual({ reason: "parked" });
  });

  it("leaves live, unknown, and boot wakes alone when failure is reported", () => {
    const start = state({ workspaces: [idleWs], activeId: "ws-1" });
    expect(
      deckReducer(start, {
        type: "failPaneWake",
        wsId: "ws-1",
        paneId: "pane-2",
      }),
    ).toBe(start);
    expect(
      deckReducer(start, {
        type: "failPaneWake",
        wsId: "ws-1",
        paneId: "nope",
      }),
    ).toBe(start);
    expect(
      deckReducer(start, {
        type: "failPaneWake",
        wsId: "nope",
        paneId: "pane-1",
      }),
    ).toBe(start);
    expect(
      deckReducer(start, {
        type: "failPaneWake",
        wsId: "ws-1",
        paneId: "pane-1",
      }),
    ).toBe(start);
  });

  it("resets pane location while preserving an idle marker", () => {
    const wtWs: Workspace = {
      ...idleWs,
      cwd: "/repo",
      panes: [
        {
          id: "pane-1",
          idle: { reason: "waking", origin: "restore" },
          cwd: "/repo/wt",
          branch: "kd/ws/1",
          session: { id: "s", boundAt: "2026-07-02T00:00:00Z" },
        },
        { id: "pane-2" },
      ],
    };
    const start = state({ workspaces: [wtWs], activeId: "ws-1" });
    const reset = deckReducer(start, {
      type: "resetPaneLocation",
      wsId: "ws-1",
      paneId: "pane-1",
    });
    expect(reset.workspaces[0].panes[0]).toEqual({
      id: "pane-1",
      idle: { reason: "waking", origin: "restore" },
    });
    expect(
      deckReducer(start, {
        type: "resetPaneLocation",
        wsId: "ws-1",
        paneId: "pane-2",
      }),
    ).toBe(start);
  });

  it("binds a session and lets a same-id report claim its journal row", () => {
    const session = { id: "s-1", boundAt: "2026-07-02T00:00:00Z" };
    const bound = deckReducer(
      state({ workspaces: [idleWs], activeId: "ws-1" }),
      {
        type: "setPaneSession",
        wsId: "ws-1",
        paneId: "pane-2",
        session,
        at: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(bound.workspaces[0].panes[1].session).toEqual(session);
    const reReported = deckReducer(bound, {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-2",
      session: { id: "s-1", boundAt: "2026-07-02T09:00:00Z" },
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(reReported.workspaces).toBe(bound.workspaces);
    expect(reReported.journal).not.toBe(bound.journal);
  });

  it("clears a session binding and preserves identity when already clear", () => {
    const session = { id: "s-1", boundAt: "2026-07-02T00:00:00Z" };
    const bound = deckReducer(
      state({ workspaces: [idleWs], activeId: "ws-1" }),
      {
        type: "setPaneSession",
        wsId: "ws-1",
        paneId: "pane-2",
        session,
        at: "2026-01-01T00:00:00.000Z",
      },
    );
    const cleared = deckReducer(bound, {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-2",
      session: null,
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(cleared.workspaces[0].panes[1].session).toBeUndefined();
    expect(
      deckReducer(cleared, {
        type: "setPaneSession",
        wsId: "ws-1",
        paneId: "pane-2",
        session: null,
        at: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(cleared);
  });
});

describe("resetPaneLocation", () => {
  it("drops durable worktree and session facts so the pane can start fresh", () => {
    const workspace: Workspace = {
      ...ws("ws-1", ["pane-1"]),
      cwd: "/repo",
      panes: [
        {
          id: "pane-1",
          idle: { reason: "waking", origin: "restore" },
          cwd: "/repo/wt",
          branch: "kd/ws/1",
          session: { id: "s-1", boundAt: "2026-07-07T00:00:00Z" },
        },
      ],
    };
    const next = deckReducer(
      state({ workspaces: [workspace], activeId: "ws-1" }),
      {
        type: "resetPaneLocation",
        wsId: "ws-1",
        paneId: "pane-1",
      },
    );
    expect(next.workspaces[0].panes[0]).toEqual({
      id: "pane-1",
      idle: { reason: "waking", origin: "restore" },
    });
  });
});

describe("deckReducer provisioning actions", () => {
  const provisioningWs: Workspace = {
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "ws-1",
    cwd: "/repo",
    worktreeBaseDir: "/wt",
    panes: [
      {
        id: "pane-1",
        provisioning: {
          repo: "/repo",
          path: "/wt/ws-1-1",
          workspace: "ws-1",
          index: 1,
        },
      },
    ],
  };

  it("resolves provisioning into durable worktree facts", () => {
    const start = state({ workspaces: [provisioningWs], activeId: "ws-1" });
    const next = deckReducer(start, {
      type: "resolvePaneProvisioning",
      wsId: "ws-1",
      paneId: "pane-1",
      cwd: "/wt/kd-ws-1",
      branch: "kd/ws-1/1",
    });
    expect(next.workspaces[0].panes[0]).toEqual({
      id: "pane-1",
      cwd: "/wt/kd-ws-1",
      branch: "kd/ws-1/1",
    });
  });

  it("ignores a late provisioning result for a closed pane", () => {
    const start = state({ workspaces: [provisioningWs], activeId: "ws-1" });
    expect(
      deckReducer(start, {
        type: "resolvePaneProvisioning",
        wsId: "ws-1",
        paneId: "closed-long-ago",
        cwd: "/x",
        branch: "b",
      }),
    ).toBe(start);
  });

  it("records and clears a provisioning error", () => {
    const start = state({ workspaces: [provisioningWs], activeId: "ws-1" });
    const failed = deckReducer(start, {
      type: "setPaneProvisioningError",
      wsId: "ws-1",
      paneId: "pane-1",
      error: "fatal: oops",
    });
    expect(failed.workspaces[0].panes[0].provisioning?.error).toBe("fatal: oops");
    const retrying = deckReducer(failed, {
      type: "setPaneProvisioningError",
      wsId: "ws-1",
      paneId: "pane-1",
      error: null,
    });
    expect(retrying.workspaces[0].panes[0].provisioning?.error).toBeUndefined();
  });
});

describe("deckReducer setWorkspacePluginSlot", () => {
  it("sets a plugin slot and returns a new state", () => {
    const start = state({ workspaces: [ws("a", [])], activeId: "a" });
    const next = deckReducer(start, {
      type: "setWorkspacePluginSlot",
      wsId: "a",
      workspaceInstance: start.workspaces[0].instance,
      pluginId: "git",
      value: { remote: "origin" },
    });
    expect(next.workspaces[0].plugins).toEqual({ git: { remote: "origin" } });
    expect(next).not.toBe(start);
  });

  it("clears the final plugin slot and drops the bag", () => {
    const start = state({ workspaces: [ws("a", [])], activeId: "a" });
    const seeded = deckReducer(start, {
      type: "setWorkspacePluginSlot",
      wsId: "a",
      workspaceInstance: start.workspaces[0].instance,
      pluginId: "git",
      value: { remote: "origin" },
    });
    const cleared = deckReducer(seeded, {
      type: "setWorkspacePluginSlot",
      wsId: "a",
      workspaceInstance: seeded.workspaces[0].instance,
      pluginId: "git",
      value: undefined,
    });
    expect("plugins" in cleared.workspaces[0]).toBe(false);
  });

  it("preserves identity for a no-op write", () => {
    const start = state({ workspaces: [ws("a", [])], activeId: "a" });
    expect(
      deckReducer(start, {
        type: "setWorkspacePluginSlot",
        wsId: "a",
        workspaceInstance: start.workspaces[0].instance,
        pluginId: "git",
        value: undefined,
      }),
    ).toBe(start);
  });

  it("rejects a write from an old workspace lifetime", () => {
    const start = state({ workspaces: [ws("a", [])], activeId: "a" });
    expect(
      deckReducer(start, {
        type: "setWorkspacePluginSlot",
        wsId: "a",
        workspaceInstance: createWorkspaceInstance(),
        pluginId: "git",
        value: { leaked: true },
      }),
    ).toBe(start);
  });
});
