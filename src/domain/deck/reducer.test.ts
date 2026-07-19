import { describe, expect, it } from "vitest";
import { deckReducer, initialDeckState, type DeckState } from "./reducer";
import { createWorkspaceInstance } from "../workspaceInstance";
import { type Workspace } from "./workspaces";

const ws = (id: string, paneIds: string[]): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: "/tmp",
  worktreeBaseDir: null,
  panes: paneIds.map((pid) => ({ id: pid })),
});

const state = (partial: Partial<DeckState>): DeckState => ({
  ...initialDeckState,
  ...partial,
});

describe("deckReducer createWorkspace", () => {
  it("rejects a duplicate live id", () => {
    const start = state({
      workspaces: [ws("a", ["a-1"])],
      activeId: "a",
      viewByWs: { a: { select: "a-1" } },
    });

    expect(
      deckReducer(start, { type: "createWorkspace", workspace: ws("a", ["other-pane"]), at: "2026-01-01T00:00:00.000Z" }),
    ).toBe(start);
  });
});

describe("deckReducer closeAgent", () => {
  it("removes the pane and moves selection/focus to the next when the closed one was active", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2"])],
        activeId: "a",
        viewByWs: { a: { focus: "a-1", select: "a-1" } },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.workspaces[0].panes.map((p) => p.id)).toEqual(["a-2"]);
    // Selection moves to the survivor; the maximize (a-1) is gone.
    expect(next.viewByWs).toEqual({ a: { select: "a-2" } });
  });

  it("clears selection when the last pane is closed", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"])],
        activeId: "a",
        viewByWs: { a: { select: "a-1" } },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.workspaces[0].panes).toEqual([]);
    // The view empties out and is pruned from the map.
    expect(next.viewByWs).toEqual({});
  });

  it("keeps selection but clears a maximize that no longer resolves (solo survivor)", () => {
    // Focus left on a now-solo workspace is masked (solo never maximizes)
    // but would spring back on the NEXT added pane, rendering it minimized
    // and invisible — the reducer must not produce that state.
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2"])],
        activeId: "a",
        viewByWs: { a: { focus: "a-2", select: "a-2" } },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1", at: "2026-01-01T00:00:00.000Z" },
    );
    // Selection kept; the now-unresolvable maximize is dropped.
    expect(next.viewByWs).toEqual({ a: { select: "a-2" } });
  });

  it("keeps a maximize that still resolves over the survivors", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: { focus: "a-2", select: "a-2" } },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-3", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.viewByWs).toEqual({ a: { focus: "a-2", select: "a-2" } });
  });
});

describe("deckReducer closeWorkspace", () => {
  it("removes the workspace, re-resolves active, and cleans its focus + selection", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"]), ws("b", ["b-1", "b-2"])],
        activeId: "a",
        viewByWs: { a: { focus: "a-1", select: "a-1" } },
      }),
      { type: "closeWorkspace", id: "a", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.workspaces.map((w) => w.id)).toEqual(["b"]);
    expect(next.activeId).toBe("b");
    // The closed workspace's whole view goes; the new active gets a default
    // selection.
    expect(next.viewByWs).toEqual({ b: { select: "b-1" } });
  });

  it("empties everything when the last workspace closes", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"])],
        activeId: "a",
        viewByWs: { a: { select: "a-1" } },
      }),
      { type: "closeWorkspace", id: "a", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.workspaces).toEqual([]);
    expect(next.activeId).toBe("");
    expect(next.viewByWs).toEqual({});
  });

  it("drops the closed workspace's whole view (dock included) in one go", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"]), ws("b", ["b-1"])],
        activeId: "a",
        viewByWs: { a: { dock: true, dockTab: "p:t" }, b: { dock: true } },
      }),
      { type: "closeWorkspace", id: "a", at: "2026-01-01T00:00:00.000Z" },
    );
    // a — dock AND dock tab — is gone; b keeps its dock and gains a default
    // selection as the new active workspace.
    expect(next.viewByWs).toEqual({ b: { dock: true, select: "b-1" } });
  });
});

describe("deckReducer dock (per workspace)", () => {
  it("toggleDock opens one workspace's dock without touching the others", () => {
    const next = deckReducer(
      state({ workspaces: [ws("a", ["a-1"]), ws("b", ["b-1"])], activeId: "a" }),
      { type: "toggleDock", wsId: "a" },
    );
    expect(next.viewByWs).toEqual({ a: { dock: true } });
  });

  it("toggleDock on an open dock removes the entry (absent = closed)", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"]), ws("b", ["b-1"])],
        activeId: "a",
        viewByWs: { a: { dock: true }, b: { dock: true } },
      }),
      { type: "toggleDock", wsId: "a" },
    );
    // a's view empties (dock was its only field) → pruned; b untouched.
    expect(next.viewByWs).toEqual({ b: { dock: true } });
  });

  it("toggleDock leaves the picked dock tab intact when only closing", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"])],
        activeId: "a",
        viewByWs: { a: { dock: true, dockTab: "keepdeck.files:tree" } },
      }),
      { type: "toggleDock", wsId: "a" },
    );
    // The tab a workspace last looked at survives closing the dock, so
    // reopening returns to it.
    expect(next.viewByWs).toEqual({ a: { dockTab: "keepdeck.files:tree" } });
  });
});

describe("deckReducer setDockTab (remembered per workspace)", () => {
  it("records the picked tab on the workspace's view", () => {
    const next = deckReducer(
      state({ workspaces: [ws("a", ["a-1"])], activeId: "a" }),
      { type: "setDockTab", wsId: "a", tabId: "keepdeck.run:presets" },
    );
    expect(next.viewByWs).toEqual({ a: { dockTab: "keepdeck.run:presets" } });
  });

  it("keeps each workspace's tab independent", () => {
    let next = deckReducer(
      state({ workspaces: [ws("a", ["a-1"]), ws("b", ["b-1"])], activeId: "a" }),
      { type: "setDockTab", wsId: "a", tabId: "p:one" },
    );
    next = deckReducer(next, { type: "setDockTab", wsId: "b", tabId: "p:two" });
    expect(next.viewByWs).toEqual({
      a: { dockTab: "p:one" },
      b: { dockTab: "p:two" },
    });
  });

  it("is a no-op (same state ref) when the tab is unchanged", () => {
    const start = state({
      workspaces: [ws("a", ["a-1"])],
      activeId: "a",
      viewByWs: { a: { dockTab: "p:one" } },
    });
    expect(
      deckReducer(start, { type: "setDockTab", wsId: "a", tabId: "p:one" }),
    ).toBe(start);
  });
});

describe("deckReducer moveWorkspace", () => {
  it("reorders the workspaces, leaving active/selection untouched", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"]), ws("b", ["b-1"]), ws("c", ["c-1"])],
        activeId: "a",
        viewByWs: { a: { select: "a-1" } },
      }),
      { type: "moveWorkspace", id: "a", toIndex: 2 },
    );
    expect(next.workspaces.map((w) => w.id)).toEqual(["b", "c", "a"]);
    expect(next.activeId).toBe("a");
    expect(next.viewByWs).toEqual({ a: { select: "a-1" } });
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
    expect(fresh.viewByWs).toEqual({ a: { select: "a-1" } });

    const kept = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2"])],
        viewByWs: { a: { select: "a-2" } },
      }),
      { type: "selectWorkspace", id: "a" },
    );
    expect(kept.viewByWs).toEqual({ a: { select: "a-2" } });
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
    expect(next.viewByWs).toEqual({ a: { select: "a-2" } });
  });

  it("addAgentPane exits a pre-existing maximize so the new pane is visible", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1"])],
        activeId: "a",
        viewByWs: { a: { focus: "a-1" } },
      }),
      {
        type: "addAgentPane",
        id: "a",
        pane: { id: "a-2", cwd: "/wt", branch: "kd/a/2" },
      },
    );
    // Maximize dropped so the appended pane isn't left hidden; it's selected.
    expect(next.viewByWs).toEqual({ a: { select: "a-2" } });
  });

  it("addAgentPane at the cap appends nothing and selects nothing", () => {
    const full = Array.from({ length: 16 }, (_, i) => `a-${i}`);
    const next = deckReducer(
      state({ workspaces: [ws("a", full)], activeId: "a" }),
      { type: "addAgentPane", id: "a", pane: { id: "overflow" } },
    );
    expect(next.workspaces[0].panes).toHaveLength(16);
    expect(next.viewByWs).toEqual({});
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
          instance: createWorkspaceInstance(),
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
    instance: createWorkspaceInstance(),
    name: "ws-1",
    cwd: "/tmp",
    worktreeBaseDir: null,
    panes: [{ id: "pane-1", dormant: true }, { id: "pane-2" }],
  };

  it("hydrate replaces the whole deck state", () => {
    const restored = state({ workspaces: [dormantWs], activeId: "ws-1" });
    const hydrated = deckReducer(initialDeckState, {
      type: "hydrate",
      state: restored,
    });
    // Everything deck.json owns is replaced wholesale; the journal slice is
    // NOT deck.json's to replace (it hydrates separately from journal.jsonl).
    expect(hydrated.workspaces).toBe(restored.workspaces);
    expect(hydrated.activeId).toBe(restored.activeId);
    expect(hydrated.viewByWs).toBe(restored.viewByWs);
    expect(hydrated.journal).toBe(initialDeckState.journal);
  });

  it("hydrate rejects duplicate workspace ids", () => {
    const current = state({ workspaces: [dormantWs], activeId: "ws-1" });
    const duplicate = state({
      workspaces: [dormantWs, ws("ws-1", ["another-pane"])],
      activeId: "ws-1",
    });

    expect(deckReducer(current, { type: "hydrate", state: duplicate })).toBe(
      current,
    );
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
      instance: createWorkspaceInstance(),
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
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(bound.workspaces[0].panes[1].session).toEqual(session);
    expect(
      deckReducer(bound, { type: "setPaneSession", wsId: "ws-1", paneId: "pane-2", session: { id: "s-1", boundAt: "2026-07-02T09:00:00Z" }, at: "2026-01-01T00:00:00.000Z" }),
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
      at: "2026-01-01T00:00:00.000Z",
    });
    const cleared = deckReducer(bound, { type: "setPaneSession", wsId: "ws-1", paneId: "pane-2", session: null, at: "2026-01-01T00:00:00.000Z" });
    expect(cleared.workspaces[0].panes[1].session).toBeUndefined();
    expect(
      deckReducer(cleared, { type: "setPaneSession", wsId: "ws-1", paneId: "pane-2", session: null, at: "2026-01-01T00:00:00.000Z" }),
    ).toBe(cleared);
  });
});

describe("resetPaneLocation", () => {
  const wtWs: Workspace = {
    id: "ws-1",
    instance: createWorkspaceInstance(),
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
    instance: createWorkspaceInstance(),
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
      workspaceInstance: start.workspaces[0].instance,
      pluginId: "git",
      value: { remote: "origin" },
    });
    expect(next.workspaces[0].plugins).toEqual({ git: { remote: "origin" } });
    expect(next).not.toBe(start);
  });

  it("clears a slot via undefined, dropping the bag when it was the last one", () => {
    const initial = state({ workspaces: [ws("a", [])], activeId: "a" });
    const seeded = deckReducer(initial, {
      type: "setWorkspacePluginSlot",
      wsId: "a",
      workspaceInstance: initial.workspaces[0].instance,
      pluginId: "git",
      value: { v: 1 },
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

  it("is a no-op (same state ref) when nothing actually changes", () => {
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

  it("rejects a write from an old lifetime after the id is reused", () => {
    const oldInstance = createWorkspaceInstance();
    const replacement = ws("a", []);
    const start = state({ workspaces: [replacement], activeId: "a" });

    expect(
      deckReducer(start, {
        type: "setWorkspacePluginSlot",
        wsId: "a",
        workspaceInstance: oldInstance,
        pluginId: "git",
        value: { leaked: true },
      }),
    ).toBe(start);
    expect(start.workspaces[0].plugins).toBeUndefined();
  });
});

describe("deckReducer toggleMinimize", () => {
  it("minimizes a pane into the minimized set", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: { select: "a-1" } },
      }),
      { type: "toggleMinimize", wsId: "a", paneId: "a-2" },
    );
    expect(next.viewByWs).toEqual({ a: { select: "a-1", minimized: ["a-2"] } });
  });

  it("restores a minimized pane and highlights it where it reappears", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: { select: "a-1", minimized: ["a-2", "a-3"] } },
      }),
      { type: "toggleMinimize", wsId: "a", paneId: "a-2" },
    );
    // a-2 leaves the set and becomes the selection; a-3 stays minimized.
    expect(next.viewByWs).toEqual({ a: { select: "a-2", minimized: ["a-3"] } });
  });

  it("prunes the whole view when the last minimized pane is restored", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2"])],
        activeId: "a",
        viewByWs: { a: { minimized: ["a-2"] } },
      }),
      { type: "toggleMinimize", wsId: "a", paneId: "a-2" },
    );
    // minimized empties → undefined; select is set to the restored pane, so the
    // view is { select: "a-2" }, not pruned to {}.
    expect(next.viewByWs).toEqual({ a: { select: "a-2" } });
  });

  it("drops a maximize when the maximized pane is itself minimized", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2"])],
        activeId: "a",
        viewByWs: { a: { focus: "a-1", select: "a-1" } },
      }),
      { type: "toggleMinimize", wsId: "a", paneId: "a-1" },
    );
    // You can't spotlight a hidden pane: focus is cleared, a-1 is minimized,
    // and the stranded selection moves to the surviving visible pane.
    expect(next.viewByWs).toEqual({ a: { select: "a-2", minimized: ["a-1"] } });
  });

  it("keeps a maximize when a DIFFERENT pane is minimized", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: { focus: "a-1", select: "a-1" } },
      }),
      { type: "toggleMinimize", wsId: "a", paneId: "a-2" },
    );
    expect(next.viewByWs).toEqual({
      a: { focus: "a-1", select: "a-1", minimized: ["a-2"] },
    });
  });

  it("moves a selection stranded on the minimized pane to the first visible one", () => {
    // The minimize click's own mousedown selects the pane being minimized, so
    // this is the NORMAL post-minimize state, not an edge case — left as-is,
    // ⌘W would target an invisible agent.
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: { select: "a-2" } },
      }),
      { type: "toggleMinimize", wsId: "a", paneId: "a-2" },
    );
    expect(next.viewByWs).toEqual({ a: { select: "a-1", minimized: ["a-2"] } });
  });

  it("restore exits a maximize on ANOTHER pane so the restored one is visible", () => {
    // Minimize C, maximize A, restore C: without clearing the focus, C's chip
    // disappears while C itself stays hidden behind A's maximize — the agent
    // just vanishes.
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: { focus: "a-1", select: "a-1", minimized: ["a-3"] } },
      }),
      { type: "toggleMinimize", wsId: "a", paneId: "a-3" },
    );
    expect(next.viewByWs).toEqual({ a: { select: "a-3" } });
  });

  it("closeAgent drops the closed pane from the minimized set", () => {
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: { select: "a-1", minimized: ["a-2", "a-3"] } },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-2", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.workspaces[0].panes.map((p) => p.id)).toEqual(["a-1", "a-3"]);
    expect(next.viewByWs).toEqual({ a: { select: "a-1", minimized: ["a-3"] } });
  });

  it("closeAgent moves the highlight to a VISIBLE survivor over a minimized one", () => {
    // Close the selected a-1 while a-2 is minimized: the highlight should land
    // on a-3 (visible), not a-2 (a hidden pane can't usefully carry it).
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: { select: "a-1", minimized: ["a-2"] } },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.viewByWs).toEqual({ a: { select: "a-3", minimized: ["a-2"] } });
  });

  it("closeAgent falls back to a minimized survivor when no visible one remains", () => {
    // Correct for the "none" style (minimized set ignored, every pane shows);
    // under tray/strip the hotkeys skip minimized targets anyway.
    const next = deckReducer(
      state({
        workspaces: [ws("a", ["a-1", "a-2"])],
        activeId: "a",
        viewByWs: { a: { select: "a-1", minimized: ["a-2"] } },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.viewByWs).toEqual({ a: { select: "a-2", minimized: ["a-2"] } });
  });
});

describe("deckReducer clearMinimized", () => {
  it("clears every minimized set while preserving the rest of each workspace view", () => {
    const next = deckReducer(
      state({
        workspaces: [
          ws("a", ["a-1", "a-2"]),
          ws("b", ["b-1"]),
          ws("c", ["c-1"]),
        ],
        activeId: "a",
        viewByWs: {
          a: { select: "a-1", dock: true, minimized: ["a-2"] },
          b: { minimized: ["b-1"] },
          c: { focus: "c-1", select: "c-1", dockTab: "git:status" },
        },
      }),
      { type: "clearMinimized" },
    );

    expect(next.viewByWs).toEqual({
      a: { select: "a-1", dock: true },
      c: { focus: "c-1", select: "c-1", dockTab: "git:status" },
    });
  });

  it("returns the same state when no workspace has minimized panes", () => {
    const start = state({
      workspaces: [ws("a", ["a-1"])],
      activeId: "a",
      viewByWs: { a: { select: "a-1" } },
    });

    expect(deckReducer(start, { type: "clearMinimized" })).toBe(start);
  });
});

describe("deckReducer journal", () => {
  const AT = "2026-07-19T12:00:00.000Z";
  const journalWs = (): Workspace => ({
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "ws-1",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes: [
      { id: "pane-1", agentType: "codex", name: "auth bug", yolo: true },
      { id: "pane-2", cwd: "/repo/wt", branch: "kd/ws/2" },
    ],
  });
  const boundState = (): DeckState => {
    const start = state({ workspaces: [journalWs()], activeId: "ws-1" });
    return deckReducer(start, {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-1",
      session: { id: "s-1", boundAt: AT },
      transcriptPath: "/t/s-1.jsonl",
      at: AT,
    });
  };

  it("binding records a live journal row with pane-derived fields", () => {
    const bound = boundState();
    expect(bound.journal.records["ws-1"]).toEqual([
      {
        agent: "codex",
        sessionId: "s-1",
        cwd: "/repo",
        yolo: true,
        transcriptPath: "/t/s-1.jsonl",
        boundAt: AT,
        state: "live",
        paneId: "pane-1",
      },
    ]);
    expect(bound.journal.tail).toHaveLength(1);
  });

  it("a worktree pane's record carries its own cwd and branch", () => {
    const start = state({ workspaces: [journalWs()], activeId: "ws-1" });
    const bound = deckReducer(start, {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-2",
      session: { id: "s-2", boundAt: AT },
      at: AT,
    });
    expect(bound.journal.records["ws-1"][0]).toMatchObject({
      agent: "claude",
      cwd: "/repo/wt",
      branch: "kd/ws/2",
    });
  });

  it("a rebind to a new session seals the old record and opens a new one", () => {
    const rebound = deckReducer(boundState(), {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-1",
      session: { id: "s-2", boundAt: AT },
      at: AT,
    });
    const rows = rebound.journal.records["ws-1"];
    expect(rows.find((r) => r.sessionId === "s-1")).toMatchObject({
      state: "closed",
      endedAt: AT,
      title: "auth bug",
    });
    expect(rows.find((r) => r.sessionId === "s-2")).toMatchObject({
      state: "live",
      paneId: "pane-1",
    });
    expect(rebound.journal.tail.map((e) => e.e)).toEqual([
      "bound",
      "sealed",
      "bound",
    ]);
  });

  it("clearing a binding seals the record", () => {
    const cleared = deckReducer(boundState(), {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-1",
      session: null,
      at: AT,
    });
    expect(cleared.journal.records["ws-1"][0]).toMatchObject({
      state: "closed",
      endedAt: AT,
    });
  });

  it("closeAgent seals with the frozen title; a never-bound pane leaves no record", () => {
    const closed = deckReducer(boundState(), {
      type: "closeAgent",
      wsId: "ws-1",
      paneId: "pane-1",
      at: AT,
    });
    expect(closed.journal.records["ws-1"][0]).toMatchObject({
      state: "closed",
      title: "auth bug",
      endedAt: AT,
    });

    const start = state({ workspaces: [journalWs()], activeId: "ws-1" });
    const noRecord = deckReducer(start, {
      type: "closeAgent",
      wsId: "ws-1",
      paneId: "pane-2",
      at: AT,
    });
    expect(noRecord.journal).toBe(start.journal);
  });

  it("closeWorkspace drops the journal key and queues the prune event", () => {
    const closed = deckReducer(boundState(), {
      type: "closeWorkspace",
      id: "ws-1",
      at: AT,
    });
    expect(closed.journal.records).toEqual({});
    expect(closed.journal.tail[closed.journal.tail.length - 1]).toMatchObject({
      e: "wsDeleted",
      wsId: "ws-1",
    });
  });

  it("createWorkspace prunes a crash-orphaned journal key on a reused id", () => {
    const orphaned = deckReducer(boundState(), {
      type: "closeWorkspace",
      id: "ws-1",
      at: AT,
    });
    // Simulate the orphan: records linger (as if the close never persisted).
    const stale: DeckState = {
      ...orphaned,
      journal: boundState().journal,
      workspaces: [],
    };
    const recreated = deckReducer(stale, {
      type: "createWorkspace",
      workspace: journalWs(),
      at: AT,
    });
    expect(recreated.journal.records).toEqual({});
  });

  it("deck hydrate preserves the live journal slice", () => {
    const bound = boundState();
    const hydrated = deckReducer(bound, {
      type: "hydrate",
      state: state({ workspaces: [journalWs()], activeId: "ws-1" }),
    });
    expect(hydrated.journal).toBe(bound.journal);
  });

  it("hydrateJournal folds the loaded records against live workspaces", () => {
    const bound = boundState();
    const hydrated = deckReducer(bound, {
      type: "hydrateJournal",
      records: {
        "ws-1": [
          {
            agent: "claude",
            sessionId: "past",
            cwd: "/repo",
            boundAt: "2026-07-18T00:00:00.000Z",
            state: "closed",
            endedAt: "2026-07-18T01:00:00.000Z",
          },
        ],
        "ws-dead": [
          {
            agent: "claude",
            sessionId: "orphan",
            cwd: "/x",
            boundAt: "2026-07-18T00:00:00.000Z",
            state: "closed",
            endedAt: "2026-07-18T01:00:00.000Z",
          },
        ],
      },
      at: AT,
    });
    expect(Object.keys(hydrated.journal.records)).toEqual(["ws-1"]);
    expect(hydrated.journal.records["ws-1"].map((r) => r.sessionId).sort()).toEqual([
      "past",
      "s-1",
    ]);
  });

  it("deleteJournalRecord drops one row; journalFlushed trims the outbox", () => {
    const bound = boundState();
    const deleted = deckReducer(bound, {
      type: "deleteJournalRecord",
      wsId: "ws-1",
      sessionId: "s-1",
      at: AT,
    });
    expect(deleted.journal.records).toEqual({});
    expect(deleted.journal.tail).toHaveLength(2);
    const flushed = deckReducer(deleted, { type: "journalFlushed", count: 2 });
    expect(flushed.journal.tail).toEqual([]);
    expect(deckReducer(flushed, { type: "journalFlushed", count: 0 })).toBe(flushed);
  });
});

describe("deckReducer journal claims on addAgentPane", () => {
  const AT = "2026-07-19T12:00:00.000Z";

  it("a pane arriving with a session claims a live journal record", () => {
    const start = state({
      workspaces: [ws("ws-1", [])],
      activeId: "ws-1",
    });
    const added = deckReducer(start, {
      type: "addAgentPane",
      id: "ws-1",
      pane: {
        id: "pane-9",
        agentType: "kimi",
        cwd: "/repo/wt",
        branch: "kd/x/9",
        session: { id: "s-res", boundAt: AT },
      },
    });
    expect(added.journal.records["ws-1"][0]).toMatchObject({
      agent: "kimi",
      sessionId: "s-res",
      cwd: "/repo/wt",
      branch: "kd/x/9",
      state: "live",
      paneId: "pane-9",
    });
  });

  it("re-claiming a sealed record preserves its frozen title and transcript path", () => {
    const start = state({
      workspaces: [ws("ws-1", [])],
      activeId: "ws-1",
      journal: {
        records: {
          "ws-1": [
            {
              agent: "kimi",
              sessionId: "s-res",
              cwd: "/repo/wt",
              title: "polish pass",
              transcriptPath: "/t/s-res",
              boundAt: "2026-07-18T00:00:00.000Z",
              state: "closed",
              endedAt: "2026-07-18T01:00:00.000Z",
            },
          ],
        },
        tail: [],
      },
    });
    const added = deckReducer(start, {
      type: "addAgentPane",
      id: "ws-1",
      pane: {
        id: "pane-9",
        agentType: "kimi",
        cwd: "/repo/wt",
        session: { id: "s-res", boundAt: AT },
      },
    });
    expect(added.journal.records["ws-1"][0]).toMatchObject({
      state: "live",
      title: "polish pass",
      transcriptPath: "/t/s-res",
      boundAt: AT,
    });
  });

  it("a sessionless pane leaves the journal untouched", () => {
    const start = state({ workspaces: [ws("ws-1", [])], activeId: "ws-1" });
    const added = deckReducer(start, {
      type: "addAgentPane",
      id: "ws-1",
      pane: { id: "pane-9", agentType: "claude" },
    });
    expect(added.journal).toBe(start.journal);
  });
});
