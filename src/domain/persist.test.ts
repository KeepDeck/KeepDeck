import { describe, expect, it } from "vitest";
import type { DeckState } from "./deck";
import { hydrateDeck, serializeDeck } from "./persist";

const state: DeckState = {
  workspaces: [
    {
      id: "ws-2",
      name: "KeepDeck",
      cwd: "/repo",
      worktreeBaseDir: "/repo/.wt",
      panes: [
        {
          id: "pane-3",
          agentType: "claude",
          cwd: "/repo/wt-3",
          branch: "kd/ws/3",
          autoTitle: "fixing auth",
          session: { id: "abc-123", boundAt: "2026-07-02T00:00:00Z" },
        },
        { id: "pane-7", agentType: "codex" },
      ],
    },
    {
      id: "ws-5",
      name: "Site",
      cwd: "/site",
      worktreeBaseDir: null,
      panes: [],
    },
  ],
  activeId: "ws-5",
  focusByWs: { "ws-2": "pane-3" },
  selectByWs: { "ws-2": "pane-3" },
};

describe("serializeDeck → hydrateDeck round-trip", () => {
  const restored = hydrateDeck(serializeDeck(state))!;

  it("restores workspaces, selection maps and the active id", () => {
    expect(restored.state.activeId).toBe("ws-5");
    expect(restored.state.focusByWs).toEqual({ "ws-2": "pane-3" });
    expect(restored.state.selectByWs).toEqual({ "ws-2": "pane-3" });
    expect(restored.state.workspaces.map((w) => w.id)).toEqual(["ws-2", "ws-5"]);
    const pane = restored.state.workspaces[0].panes[0];
    expect(pane.cwd).toBe("/repo/wt-3");
    expect(pane.branch).toBe("kd/ws/3");
    expect(pane.autoTitle).toBe("fixing auth");
    expect(pane.session).toEqual({ id: "abc-123", boundAt: "2026-07-02T00:00:00Z" });
  });

  it("marks every restored pane dormant", () => {
    for (const ws of restored.state.workspaces) {
      for (const pane of ws.panes) expect(pane.dormant).toBe(true);
    }
  });

  it("derives the id-mint seeds from the highest persisted ids", () => {
    expect(restored.nextAgentSeq).toBe(8); // pane-7 + 1
    expect(restored.nextWorkspaceSeq).toBe(6); // ws-5 + 1
  });

  it("does not persist the runtime dormant flag", () => {
    const dormantState: DeckState = {
      ...state,
      workspaces: [
        {
          ...state.workspaces[0],
          panes: state.workspaces[0].panes.map((p) => ({ ...p, dormant: true })),
        },
      ],
    };
    expect(serializeDeck(dormantState)).not.toContain("dormant");
  });
});

describe("hydrateDeck — unusable input", () => {
  it("rejects non-JSON, wrong versions and malformed shapes", () => {
    expect(hydrateDeck("not json")).toBeNull();
    expect(hydrateDeck(JSON.stringify({ version: 99, workspaces: [] }))).toBeNull();
    expect(hydrateDeck(JSON.stringify({ version: 1 }))).toBeNull();
    // A workspace without a cwd is unusable — quarantine the whole file.
    expect(
      hydrateDeck(
        JSON.stringify({
          version: 1,
          activeId: "",
          focusByWs: {},
          selectByWs: {},
          workspaces: [{ id: "ws-1", name: "x", panes: [] }],
        }),
      ),
    ).toBeNull();
  });
});

describe("hydrateDeck — tolerated degradations", () => {
  const json = JSON.stringify({
    version: 1,
    activeId: "ws-gone",
    focusByWs: { "ws-1": "pane-gone", "ws-gone": "pane-1" },
    selectByWs: { "ws-1": "pane-1" },
    workspaces: [
      {
        id: "ws-1",
        name: "x",
        cwd: "/x",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "some-future-agent" }],
      },
    ],
  });
  const restored = hydrateDeck(json)!;

  it("resolves a stale activeId to an existing workspace", () => {
    expect(restored.state.activeId).toBe("ws-1");
  });

  it("drops focus/selection entries pointing at unknown ids", () => {
    expect(restored.state.focusByWs).toEqual({});
    expect(restored.state.selectByWs).toEqual({ "ws-1": "pane-1" });
  });

  it("degrades an unknown agentType to the default instead of rejecting", () => {
    expect(restored.state.workspaces[0].panes[0].agentType).toBeUndefined();
  });

  it("seeds mints at 1 when no ids match the minted format", () => {
    const custom = hydrateDeck(
      JSON.stringify({
        version: 1,
        activeId: "",
        focusByWs: {},
        selectByWs: {},
        workspaces: [
          { id: "imported", name: "x", cwd: "/x", worktreeBaseDir: null, panes: [] },
        ],
      }),
    )!;
    expect(custom.nextAgentSeq).toBe(1);
    expect(custom.nextWorkspaceSeq).toBe(1);
  });
});
