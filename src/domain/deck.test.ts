import { describe, expect, it } from "vitest";
import { deckReducer, initialDeckState, type DeckState } from "./deck";
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

  it("leaves selection/focus untouched when a non-selected pane is closed", () => {
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
