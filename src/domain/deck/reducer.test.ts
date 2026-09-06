import { describe, expect, it } from "vitest";
import { deckReducer } from "./reducer";
import { createWorkspaceInstance } from "../workspaceInstance";
import {
  deckState as state,
  team,
  teamedWorkspace as tws,
  workspace as ws,
} from "./reducer.testSupport";
import type { Workspace } from "./workspaces";

/** The view of a workspace with `team-1` open — where a highlight lives. */
const open = (view: Record<string, unknown> = {}) => ({ teamOpen: "team-1", ...view });

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
        workspaces: [tws("a", ["a-1", "a-2"])],
        activeId: "a",
        viewByWs: { a: open({ focus: "a-1", select: "a-1" }) },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.workspaces[0].panes.map((p) => p.id)).toEqual(["a-2"]);
    // Selection moves to the survivor; the maximize (a-1) is gone.
    expect(next.viewByWs).toEqual({ a: open({ select: "a-2" }) });
  });

  it("clears selection when the last pane is closed", () => {
    const next = deckReducer(
      state({
        workspaces: [tws("a", ["a-1"])],
        activeId: "a",
        viewByWs: { a: open({ select: "a-1" }) },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.workspaces[0].panes).toEqual([]);
    // Nothing is left to highlight; the team stays open — an empty team is
    // still a team, and leaving it is the person's own step (or a disband).
    expect(next.viewByWs).toEqual({ a: open() });
  });

  it("never moves the highlight onto another team's pane", () => {
    // The closed pane was the open team's last member; the other team's
    // pane survives, but it is not laid out, so nothing is highlighted.
    const next = deckReducer(
      state({
        workspaces: [twoTeams()],
        activeId: "a",
        viewByWs: { a: { teamOpen: "team-1", select: "a-1" } },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.viewByWs).toEqual({ a: { teamOpen: "team-1" } });
  });

  it("keeps selection but clears a maximize that no longer resolves (solo survivor)", () => {
    // Focus left on a now-solo workspace is masked (solo never maximizes)
    // but would spring back on the NEXT added pane, rendering it minimized
    // and invisible — the reducer must not produce that state.
    const next = deckReducer(
      state({
        workspaces: [tws("a", ["a-1", "a-2"])],
        activeId: "a",
        viewByWs: { a: open({ focus: "a-2", select: "a-2" }) },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1", at: "2026-01-01T00:00:00.000Z" },
    );
    // Selection kept; the now-unresolvable maximize is dropped.
    expect(next.viewByWs).toEqual({ a: open({ select: "a-2" }) });
  });

  it("keeps a maximize that still resolves over the survivors", () => {
    const next = deckReducer(
      state({
        workspaces: [tws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: open({ focus: "a-2", select: "a-2" }) },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-3", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.viewByWs).toEqual({ a: open({ focus: "a-2", select: "a-2" }) });
  });
});

/** Two teams: a-1 on team-1, a-2 and a-3 on team-2. */
const twoTeams = (): Workspace => ({
  ...tws("a", ["a-1", "a-2", "a-3"]),
  teams: [team("team-1"), team("team-2")],
  panes: [
    { id: "a-1", team: { teamId: "team-1", role: "lead" } },
    { id: "a-2", team: { teamId: "team-2", role: "lead" } },
    { id: "a-3", team: { teamId: "team-2", role: "impl-1" } },
  ],
});

describe("deckReducer openTeam / closeTeam", () => {
  const at = "2026-01-01T00:00:00.000Z";

  it("opens a team and lands the highlight on its first member on the grid", () => {
    const next = deckReducer(
      state({ workspaces: [twoTeams()], activeId: "a", viewByWs: { a: { select: "a-1" } } }),
      { type: "openTeam", wsId: "a", teamId: "team-2" },
    );
    // a-1 is another team's: the highlight moves to the first of team-2.
    expect(next.viewByWs).toEqual({ a: { teamOpen: "team-2", select: "a-2" } });
  });

  it("keeps a highlight already on the team, and skips a minimized member for a new one", () => {
    const kept = deckReducer(
      state({ workspaces: [twoTeams()], activeId: "a", viewByWs: { a: { select: "a-3" } } }),
      { type: "openTeam", wsId: "a", teamId: "team-2" },
    );
    expect(kept.viewByWs).toEqual({ a: { teamOpen: "team-2", select: "a-3" } });

    const skipped = deckReducer(
      state({ workspaces: [twoTeams()], activeId: "a", viewByWs: { a: { minimized: ["a-2"] } } }),
      { type: "openTeam", wsId: "a", teamId: "team-2" },
    );
    // The same repair `hidePaneView` makes: ⌘W must never target a pane
    // the person cannot see.
    expect(skipped.viewByWs).toEqual({ a: { teamOpen: "team-2", minimized: ["a-2"], select: "a-3" } });
  });

  it("drops a spotlight on another team's pane and keeps one on this team's", () => {
    const foreign = deckReducer(
      state({ workspaces: [twoTeams()], activeId: "a", viewByWs: { a: { focus: "a-1", select: "a-1" } } }),
      { type: "openTeam", wsId: "a", teamId: "team-2" },
    );
    expect(foreign.viewByWs).toEqual({ a: { teamOpen: "team-2", select: "a-2" } });

    const own = deckReducer(
      state({ workspaces: [twoTeams()], activeId: "a", viewByWs: { a: { focus: "a-3", select: "a-3" } } }),
      { type: "openTeam", wsId: "a", teamId: "team-2" },
    );
    expect(own.viewByWs).toEqual({ a: { teamOpen: "team-2", focus: "a-3", select: "a-3" } });
  });

  it("refuses a team the workspace does not have, with the same state", () => {
    const start = state({ workspaces: [twoTeams()], activeId: "a" });
    expect(deckReducer(start, { type: "openTeam", wsId: "a", teamId: "team-404" })).toBe(start);
    expect(deckReducer(start, { type: "openTeam", wsId: "b", teamId: "team-1" })).toBe(start);
  });

  it("closeTeam returns to the cards: no team open, nothing highlighted, the dock as it was", () => {
    const next = deckReducer(
      state({
        workspaces: [twoTeams()],
        activeId: "a",
        viewByWs: { a: { teamOpen: "team-2", select: "a-2", dock: true } },
      }),
      { type: "closeTeam", wsId: "a" },
    );
    expect(next.viewByWs).toEqual({ a: { dock: true } });
    // A view with nothing else in it is pruned, like every other emptying.
    const pruned = deckReducer(
      state({ workspaces: [twoTeams()], activeId: "a", viewByWs: { a: { teamOpen: "team-2", select: "a-2" } } }),
      { type: "closeTeam", wsId: "a" },
    );
    expect(pruned.viewByWs).toEqual({});
  });

  it("dissolving the open team is the way back to the cards; another team's dissolve is not", () => {
    // Only a team with nobody on it dissolves: team-2 once its members are gone.
    const emptied = { ...twoTeams(), panes: [{ id: "a-1", team: { teamId: "team-1", role: "lead" } }] };
    const back = deckReducer(
      state({ workspaces: [emptied], activeId: "a", viewByWs: { a: { teamOpen: "team-2" } } }),
      { type: "dissolveTeam", wsId: "a", teamId: "team-2" },
    );
    expect(back.workspaces[0].teams?.map((candidate) => candidate.id)).toEqual(["team-1"]);
    expect(back.viewByWs).toEqual({});

    const elsewhere = deckReducer(
      state({ workspaces: [emptied], activeId: "a", viewByWs: { a: { teamOpen: "team-1", select: "a-1" } } }),
      { type: "dissolveTeam", wsId: "a", teamId: "team-2" },
    );
    expect(elsewhere.viewByWs).toEqual({ a: { teamOpen: "team-1", select: "a-1" } });
    // A refused dissolve (members on it) changes nothing, view included.
    const start = state({ workspaces: [twoTeams()], activeId: "a", viewByWs: { a: { teamOpen: "team-2" } } });
    expect(deckReducer(start, { type: "dissolveTeam", wsId: "a", teamId: "team-2" })).toBe(start);
    void at;
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
    // The closed workspace's whole view goes; the new active gets no
    // default selection — it opens at its cards, where no pane is in front
    // of the person.
    expect(next.viewByWs).toEqual({});
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
    // a — dock AND dock tab — is gone; b keeps its dock.
    expect(next.viewByWs).toEqual({ b: { dock: true } });
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
  it("selectWorkspace defaults selection to the open team's first member only when unset", () => {
    const fresh = deckReducer(
      state({ workspaces: [tws("a", ["a-1", "a-2"])], viewByWs: { a: open() } }),
      { type: "selectWorkspace", id: "a" },
    );
    expect(fresh.viewByWs).toEqual({ a: open({ select: "a-1" }) });

    const kept = deckReducer(
      state({
        workspaces: [tws("a", ["a-1", "a-2"])],
        viewByWs: { a: open({ select: "a-2" }) },
      }),
      { type: "selectWorkspace", id: "a" },
    );
    expect(kept.viewByWs).toEqual({ a: open({ select: "a-2" }) });

    // At the cards level nothing is a pane to highlight.
    const cards = deckReducer(state({ workspaces: [tws("a", ["a-1", "a-2"])] }), {
      type: "selectWorkspace",
      id: "a",
    });
    expect(cards.viewByWs).toEqual({});
  });

  it("addAgentPane appends and selects it when it lands on the open team", () => {
    const next = deckReducer(
      state({ workspaces: [tws("a", ["a-1"])], activeId: "a", viewByWs: { a: open() } }),
      {
        type: "addAgentPane",
        id: "a",
        pane: { id: "a-2", team: { teamId: "team-1", role: "lead" } },
      },
    );
    expect(next.workspaces[0].panes.map((p) => p.id)).toEqual(["a-1", "a-2"]);
    expect(next.viewByWs).toEqual({ a: open({ select: "a-2" }) });
  });

  it("addAgentPane onto a team that is not open leaves the view alone", () => {
    // An agent's team.create, a resume into another team: the pane is not
    // laid out, and the team in front of the person must not move for it.
    const next = deckReducer(
      state({
        workspaces: [twoTeams()],
        activeId: "a",
        viewByWs: { a: { teamOpen: "team-2", focus: "a-2", select: "a-2" } },
      }),
      {
        type: "addAgentPane",
        id: "a",
        pane: { id: "a-4", team: { teamId: "team-1", role: "impl-1" } },
      },
    );
    expect(next.workspaces[0].panes.map((p) => p.id)).toEqual(["a-1", "a-2", "a-3", "a-4"]);
    expect(next.viewByWs).toEqual({ a: { teamOpen: "team-2", focus: "a-2", select: "a-2" } });
  });

  it("addAgentPane exits a pre-existing maximize so the new pane is visible", () => {
    const next = deckReducer(
      state({
        workspaces: [tws("a", ["a-1"])],
        activeId: "a",
        viewByWs: { a: open({ focus: "a-1" }) },
      }),
      {
        type: "addAgentPane",
        id: "a",
        pane: { id: "a-2", team: { teamId: "team-1", role: "lead" } },
      },
    );
    // Maximize dropped so the appended pane isn't left hidden; it's selected.
    expect(next.viewByWs).toEqual({ a: open({ select: "a-2" }) });
  });

  it("addAgentPane past sixteen still appends — the cap is the team's", () => {
    const full = Array.from({ length: 16 }, (_, i) => `a-${i}`);
    const next = deckReducer(
      state({ workspaces: [ws("a", full)], activeId: "a" }),
      { type: "addAgentPane", id: "a", pane: { id: "overflow" } },
    );
    expect(next.workspaces[0].panes).toHaveLength(17);
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
        workspaces: [tws("a", ["a-1", "a-2"])],
        activeId: "a",
        viewByWs: { a: open({ focus: "a-1", select: "a-1" }) },
      }),
      { type: "toggleMinimize", wsId: "a", paneId: "a-1" },
    );
    // You can't spotlight a hidden pane: focus is cleared, a-1 is minimized,
    // and the stranded selection moves to the surviving visible pane.
    expect(next.viewByWs).toEqual({ a: open({ select: "a-2", minimized: ["a-1"] }) });
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
        workspaces: [tws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: open({ select: "a-2" }) },
      }),
      { type: "toggleMinimize", wsId: "a", paneId: "a-2" },
    );
    expect(next.viewByWs).toEqual({ a: open({ select: "a-1", minimized: ["a-2"] }) });
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
        workspaces: [tws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: open({ select: "a-1", minimized: ["a-2", "a-3"] }) },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-2", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.workspaces[0].panes.map((p) => p.id)).toEqual(["a-1", "a-3"]);
    expect(next.viewByWs).toEqual({ a: open({ select: "a-1", minimized: ["a-3"] }) });
  });

  it("closeAgent moves the highlight to a VISIBLE survivor over a minimized one", () => {
    // Close the selected a-1 while a-2 is minimized: the highlight should land
    // on a-3 (visible), not a-2 (a hidden pane can't usefully carry it).
    const next = deckReducer(
      state({
        workspaces: [tws("a", ["a-1", "a-2", "a-3"])],
        activeId: "a",
        viewByWs: { a: open({ select: "a-1", minimized: ["a-2"] }) },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.viewByWs).toEqual({ a: open({ select: "a-3", minimized: ["a-2"] }) });
  });

  it("closeAgent falls back to a minimized survivor when no visible one remains", () => {
    // Correct for the "none" style (minimized set ignored, every pane shows);
    // under tray/strip the hotkeys skip minimized targets anyway.
    const next = deckReducer(
      state({
        workspaces: [tws("a", ["a-1", "a-2"])],
        activeId: "a",
        viewByWs: { a: open({ select: "a-1", minimized: ["a-2"] }) },
      }),
      { type: "closeAgent", wsId: "a", paneId: "a-1", at: "2026-01-01T00:00:00.000Z" },
    );
    expect(next.viewByWs).toEqual({ a: open({ select: "a-2", minimized: ["a-2"] }) });
  });
});
