import { describe, expect, it } from "vitest";
import { deckReducer, initialDeckState, type DeckState } from "./reducer";
import { type Workspace } from "./workspaces";

const ws = (id: string, paneIds: string[]): Workspace => ({
  id,
  name: id,
  cwd: "/tmp",
  worktreeBaseDir: null,
  panes: paneIds.map((pid) => ({ id: pid })),
});

const state = (partial: Partial<DeckState>): DeckState => ({
  ...initialDeckState,
  ...partial,
});

describe("deckReducer closeAgent", () => {
  it("removes the pane and moves selection/focus to the next when the closed one was active", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2"])],
        activeId: "a",
        focusByWs: { a: "a-1" },
        selectByWs: { a: "a-1" },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1" },
    );
    expect(next.workspaces[0].panes.map((p) => p.id)).toEqual(["a-2"]);
    expect(next.selectByWs).toEqual({ a: "a-2" });
    expect(next.focusByWs).toEqual({});
  });

  it("clears selection when the last pane is closed", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"])],
        activeId: "a",
        selectByWs: { a: "a-1" },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1" },
    );
    expect(next.workspaces[0].panes).toEqual([]);
    expect(next.selectByWs).toEqual({});
  });

  it("keeps selection but clears a maximize that no longer resolves (solo survivor)", () => {
    // Focus left on a now-solo workspace is masked (solo never maximizes)
    // but would spring back on the NEXT added pane, rendering it collapsed
    // and invisible — the reducer must not produce that state.
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2"])],
        activeId: "a",
        focusByWs: { a: "a-2" },
        selectByWs: { a: "a-2" },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1" },
    );
    expect(next.selectByWs).toEqual({ a: "a-2" });
    expect(next.focusByWs).toEqual({});
  });

  it("keeps a maximize that still resolves over the survivors", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        focusByWs: { a: "a-2" },
        selectByWs: { a: "a-2" },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-3" },
    );
    expect(next.focusByWs).toEqual({ a: "a-2" });
  });
});

describe("deckReducer closeWorkspace", () => {
  it("removes the workspace, re-resolves active, and cleans its focus + selection", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"]), ws("b", ["b-1", "b-2"])],
        activeId: "a",
        focusByWs: { a: "a-1" },
        selectByWs: { a: "a-1" },
      }),
      { type: "closeWorkspace", id: "a" },
    );
    expect(next.workspaces.map((w) => w.id)).toEqual(["b"]);
    expect(next.activeId).toBe("b");
    expect(next.focusByWs).toEqual({});
    expect(next.selectByWs).toEqual({ b: "b-1" });
  });

  it("empties everything when the last workspace closes", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"])],
        activeId: "a",
        selectByWs: { a: "a-1" },
      }),
      { type: "closeWorkspace", id: "a" },
    );
    expect(next.workspaces).toEqual([]);
    expect(next.activeId).toBe("");
    expect(next.selectByWs).toEqual({});
  });

  it("drops the closed workspace's dock entry", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"]), ws("b", ["b-1"])],
        activeId: "a",
        dockByWs: { a: true, b: true },
      }),
      { type: "closeWorkspace", id: "a" },
    );
    expect(next.dockByWs).toEqual({ b: true });
  });
});

describe("deckReducer dock (Run panel per workspace)", () => {
  it("toggleDock opens one workspace's dock without touching the others", () => {
    const next = deckReducer(
      state({ workspaces: [ws("a", ["a-1"]), ws("b", ["b-1"])], activeId: "a" }),
      { type: "toggleDock", wsId: "a" },
    );
    expect(next.dockByWs).toEqual({ a: true });
  });

  it("toggleDock on an open dock removes the entry (absent = closed)", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"]), ws("b", ["b-1"])],
        activeId: "a",
        dockByWs: { a: true, b: true },
      }),
      { type: "toggleDock", wsId: "a" },
    );
    expect(next.dockByWs).toEqual({ b: true });
  });

  it("openDock reveals the dock and is a no-op (same ref) when already open", () => {
    const closed = state({ workspaces: [ws("a", ["a-1"])], activeId: "a" });
    const opened = deckReducer(closed, { type: "openDock", wsId: "a" });
    expect(opened.dockByWs).toEqual({ a: true });
    // A repeated ▶ shortcut must not cause a re-render.
    expect(deckReducer(opened, { type: "openDock", wsId: "a" })).toBe(opened);
  });
});

describe("deckReducer moveWorkspace", () => {
  it("reorders the workspaces, leaving active/selection untouched", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"]), ws("b", ["b-1"]), ws("c", ["c-1"])],
        activeId: "a",
        selectByWs: { a: "a-1" },
      }),
      { type: "moveWorkspace", id: "a", toIndex: 2 },
    );
    expect(next.workspaces.map((w) => w.id)).toEqual(["b", "c", "a"]);
    expect(next.activeId).toBe("a");
    expect(next.selectByWs).toEqual({ a: "a-1" });
  });

  it("returns the SAME state ref on a no-op move", () => {
    const start = state({
      workspaces: [ws("a", []), ws("b", [])],
      activeId: "a",
    });
    expect(
      deckReducer(start, { type: "moveWorkspace", id: "a", toIndex: 0 }),
    ).toBe(start);
  });
});

describe("deckReducer selection", () => {
  it("selectWorkspace defaults selection to the first pane only when unset", () => {
    const fresh = deckReducer(state({ workspaces: [ws("a", ["a-1", "a-2"])] }), {
      type: "selectWorkspace",
      id: "a",
    });
    expect(fresh.selectByWs).toEqual({ a: "a-1" });

    const kept = deckReducer(
      state({ workspaces: [ws("a", ["a-1", "a-2"])], selectByWs: { a: "a-2" } }),
      { type: "selectWorkspace", id: "a" },
    );
    expect(kept.selectByWs).toEqual({ a: "a-2" });
  });

  it("addAgentPane appends and selects it", () => {
    const next = deckReducer(
      state({ workspaces: [ws("a", ["a-1"])], activeId: "a" }),
      {
        type: "addAgentPane",
        id: "a",
        pane: { id: "a-2", cwd: "/wt", branch: "kd/a/2" },
      },
    );
    expect(next.workspaces[0].panes.map((p) => p.id)).toEqual(["a-1", "a-2"]);
    expect(next.selectByWs).toEqual({ a: "a-2" });
  });

  it("addAgentPane at the cap appends nothing and selects nothing", () => {
    const full = Array.from({ length: 16 }, (_, i) => `a-${i}`);
    const next = deckReducer(
      state({ workspaces: [ws("a", full)], activeId: "a" }),
      { type: "addAgentPane", id: "a", pane: { id: "overflow" } },
    );
    expect(next.workspaces[0].panes).toHaveLength(16);
    expect(next.selectByWs).toEqual({});
  });
});

describe("deckReducer pane naming", () => {
  it("renamePane sets the pane's manual name", () => {
    const next = deckReducer(
      state({ workspaces: [ws("a", ["a-1"])], activeId: "a" }),
      { type: "renamePane", wsId: "a", paneId: "a-1", name: "Build" },
    );
    expect(next.workspaces[0].panes[0]).toEqual({ id: "a-1", name: "Build" });
  });

  it("setPaneAutoTitle sets the auto title", () => {
    const next = deckReducer(
      state({ workspaces: [ws("a", ["a-1"])], activeId: "a" }),
      { type: "setPaneAutoTitle", wsId: "a", paneId: "a-1", title: "~/x" },
    );
    expect(next.workspaces[0].panes[0]).toEqual({ id: "a-1", autoTitle: "~/x" });
  });

  it("setPaneAutoTitle returns the SAME state when the title is unchanged", () => {
    const start = state({
      workspaces: [
        {
          id: "a",
          name: "a",
          cwd: "/tmp",
          worktreeBaseDir: null,
          panes: [{ id: "a-1", autoTitle: "same" }],
        },
      ],
      activeId: "a",
    });
    const next = deckReducer(start, {
      type: "setPaneAutoTitle",
      wsId: "a",
      paneId: "a-1",
      title: "same",
    });
    expect(next).toBe(start); // no change → same ref → no re-render
  });
});

describe("deckReducer restore actions ([F7])", () => {
  const dormantWs: Workspace = {
    id: "ws-1",
    name: "ws-1",
    cwd: "/tmp",
    worktreeBaseDir: null,
    panes: [{ id: "pane-1", dormant: true }, { id: "pane-2" }],
  };

  it("hydrate replaces the whole deck state", () => {
    const restored = state({ workspaces: [dormantWs], activeId: "ws-1" });
    expect(
      deckReducer(initialDeckState, { type: "hydrate", state: restored }),
    ).toBe(restored);
  });

  it("revivePane clears the dormant flag", () => {
    const next = deckReducer(state({ workspaces: [dormantWs], activeId: "ws-1" }), {
      type: "revivePane",
      wsId: "ws-1",
      paneId: "pane-1",
    });
    expect(next.workspaces[0].panes[0]).toEqual({ id: "pane-1" });
  });

  it("revivePane is a no-op (same ref) for a live or unknown pane", () => {
    const start = state({ workspaces: [dormantWs], activeId: "ws-1" });
    expect(
      deckReducer(start, { type: "revivePane", wsId: "ws-1", paneId: "pane-2" }),
    ).toBe(start);
    expect(
      deckReducer(start, { type: "revivePane", wsId: "ws-1", paneId: "nope" }),
    ).toBe(start);
  });

  it("resetPaneLocation drops cwd/branch/session; no-op when nothing to drop", () => {
    const wtWs: Workspace = {
      id: "ws-1",
      name: "ws-1",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        {
          id: "pane-1",
          dormant: true,
          cwd: "/repo/wt",
          branch: "kd/ws/1",
          session: { id: "s", boundAt: "2026-07-02T00:00:00Z" },
        },
        { id: "pane-2" },
      ],
    };
    const start = state({ workspaces: [wtWs], activeId: "ws-1" });
    const next = deckReducer(start, {
      type: "resetPaneLocation",
      wsId: "ws-1",
      paneId: "pane-1",
    });
    // Location and resume key are gone; the pane itself (and dormancy) remain.
    expect(next.workspaces[0].panes[0]).toEqual({ id: "pane-1", dormant: true });
    expect(
      deckReducer(start, {
        type: "resetPaneLocation",
        wsId: "ws-1",
        paneId: "pane-2",
      }),
    ).toBe(start);
  });

  it("setPaneSession binds the resume key and no-ops on a same-id rebind", () => {
    const session = { id: "s-1", boundAt: "2026-07-02T00:00:00Z" };
    const start = state({ workspaces: [dormantWs], activeId: "ws-1" });
    const bound = deckReducer(start, {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-2",
      session,
    });
    expect(bound.workspaces[0].panes[1].session).toEqual(session);
    expect(
      deckReducer(bound, {
        type: "setPaneSession",
        wsId: "ws-1",
        paneId: "pane-2",
        session: { id: "s-1", boundAt: "2026-07-02T09:00:00Z" },
      }),
    ).toBe(bound);
  });

  it("setPaneSession(null) drops a dead binding; clearing a clear pane no-ops", () => {
    const session = { id: "ghost", boundAt: "2026-07-02T00:00:00Z" };
    const start = state({ workspaces: [dormantWs], activeId: "ws-1" });
    const bound = deckReducer(start, {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-2",
      session,
    });
    const cleared = deckReducer(bound, {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-2",
      session: null,
    });
    expect(cleared.workspaces[0].panes[1].session).toBeUndefined();
    expect(
      deckReducer(cleared, {
        type: "setPaneSession",
        wsId: "ws-1",
        paneId: "pane-2",
        session: null,
      }),
    ).toBe(cleared);
  });
});

describe("resetPaneLocation", () => {
  const wtWs: Workspace = {
    id: "ws-1",
    name: "ws-1",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes: [
      {
        id: "pane-1",
        dormant: true,
        cwd: "/repo/wt",
        branch: "kd/ws/1",
        session: { id: "s1", boundAt: "2026-07-07T00:00:00Z" },
      },
    ],
  };

  it("drops durable location and session state so the pane can start fresh", () => {
    const start = state({ workspaces: [wtWs], activeId: "ws-1" });
    const next = deckReducer(start, {
      type: "resetPaneLocation",
      wsId: "ws-1",
      paneId: "pane-1",
    });
    expect(next.workspaces[0].panes[0]).toEqual({ id: "pane-1", dormant: true });
  });
});

describe("deckReducer provisioning actions", () => {
  const provisioningWs: Workspace = {
    id: "ws-1",
    name: "ws-1",
    cwd: "/repo",
    worktreeBaseDir: "/wt",
    panes: [
      {
        id: "pane-1",
        provisioning: { repo: "/repo", baseDir: "/wt", workspace: "ws-1", index: 1 },
      },
    ],
  };

  it("resolvePaneProvisioning pins the created worktree onto the pane", () => {
    const next = deckReducer(
      state({ workspaces: [provisioningWs], activeId: "ws-1" }),
      {
        type: "resolvePaneProvisioning",
        wsId: "ws-1",
        paneId: "pane-1",
        cwd: "/wt/kd-ws-1",
        branch: "kd/ws-1/1",
      },
    );
    expect(next.workspaces[0].panes[0]).toEqual({
      id: "pane-1",
      cwd: "/wt/kd-ws-1",
      branch: "kd/ws-1/1",
    });
  });

  it("a late resolve for a closed pane is a no-op (same state ref)", () => {
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

  it("setPaneProvisioningError flips the card to failed and a retry flips it back", () => {
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
  it("sets a plugin's slot and returns a NEW state (re-render)", () => {
    const start = state({ workspaces: [ws("a", [])], activeId: "a" });
    const next = deckReducer(start, {
      type: "setWorkspacePluginSlot",
      wsId: "a",
      pluginId: "git",
      value: { remote: "origin" },
    });
    expect(next.workspaces[0].plugins).toEqual({ git: { remote: "origin" } });
    expect(next).not.toBe(start);
  });

  it("clears a slot via undefined, dropping the bag when it was the last one", () => {
    const seeded = deckReducer(
      state({ workspaces: [ws("a", [])], activeId: "a" }),
      { type: "setWorkspacePluginSlot", wsId: "a", pluginId: "git", value: { v: 1 } },
    );
    const cleared = deckReducer(seeded, {
      type: "setWorkspacePluginSlot",
      wsId: "a",
      pluginId: "git",
      value: undefined,
    });
    expect("plugins" in cleared.workspaces[0]).toBe(false);
  });

  it("is a no-op (same state ref) when nothing actually changes", () => {
    const start = state({ workspaces: [ws("a", [])], activeId: "a" });
    expect(
      deckReducer(start, {
        type: "setWorkspacePluginSlot",
        wsId: "a",
        pluginId: "git",
        value: undefined,
      }),
    ).toBe(start);
  });
});
