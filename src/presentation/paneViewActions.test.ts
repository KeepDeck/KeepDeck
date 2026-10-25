import { describe, expect, it, vi } from "vitest";
import {
  deckReducer,
  hiddenBy,
  initialDeckState,
  paneOnScreen,
  stagePanes,
  type DeckAction,
  type DeckState,
  type HideReason,
  type Team,
  type WorkspaceView,
} from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createPaneViewActions } from "./paneViewActions";
import type { PaneInputFocusPort } from "./paneInputFocusController";

const team = (id: string): Team => ({ id, name: id, location: { kind: "attached", cwd: "/repo" } });

/** Two panes on team-1, which is open — or, `apart`, pane-2 on a team of
 * its own, team-2, with team-1 still the open one. */
const deckWith = (view: WorkspaceView = {}, apart = false) => {
  let state: DeckState = {
    ...initialDeckState,
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "Workspace",
        cwd: "/repo",
        worktreeBaseDir: null,
        teams: apart ? [team("team-1"), team("team-2")] : [team("team-1")],
        panes: [
          { id: "pane-1", team: { teamId: "team-1", role: "lead" } },
          { id: "pane-2", team: { teamId: apart ? "team-2" : "team-1", role: apart ? "lead" : "impl-1" } },
        ],
      },
    ],
    activeId: "ws-1",
    viewByWs: { "ws-1": { teamOpen: "team-1", ...view } },
  };
  return {
    getSnapshot: () => state,
    dispatch(action: DeckAction) {
      state = deckReducer(state, action);
      return state;
    },
  };
};

const viewActions = (deck: ReturnType<typeof deckWith>, focus: PaneInputFocusPort) =>
  createPaneViewActions(deck, {
    openTeam: (wsId, teamId) => { deck.dispatch({ type: "openTeam", wsId, teamId }); },
    toggleMinimize: (wsId, paneId) => { deck.dispatch({ type: "toggleMinimize", wsId, paneId }); },
    restoreSuspendedPane: (wsId, paneId) => { deck.dispatch({ type: "restoreSuspendedPane", wsId, paneId }); },
    toggleFocus: (wsId, paneId) => { deck.dispatch({ type: "toggleFocus", wsId, paneId }); },
  }, focus);

describe("PaneViewActions", () => {
  it("opens the pane's team before any marker comes off — a reveal into another team lands there", () => {
    // A notification about a pane of a team that is not open: the click has
    // to end with that pane in front of the person, which means its team
    // open FIRST — the restore's own highlight has to land on the slice
    // that is then in view, and a marker removed on a closed team's pane
    // would reveal nothing.
    const deck = deckWith({ select: "pane-1", minimized: ["pane-2"] }, true);
    const actions = viewActions(deck, { requestFocus: vi.fn() });

    actions.revealPane("ws-1", "pane-2");

    const after = deck.getSnapshot();
    expect(after.viewByWs["ws-1"]).toEqual({ teamOpen: "team-2", select: "pane-2" });
    expect(paneOnScreen(stagePanes(after.workspaces[0], after.viewByWs["ws-1"]), after.viewByWs["ws-1"], "pane-2")).toBe(true);
  });

  it("requests terminal focus after every maximize transition", () => {
    const deck = deckWith({ select: "pane-1" });
    const observedLayouts: Array<readonly string[] | undefined> = [];
    const requestFocus = vi.fn(() =>
      observedLayouts.push(deck.getSnapshot().viewByWs["ws-1"]?.focus),
    );
    const actions = viewActions(deck, { requestFocus });

    actions.toggleMaximize("ws-1", "pane-1");
    actions.toggleMaximize("ws-1", "pane-1");

    expect(requestFocus).toHaveBeenCalledTimes(2);
    expect(requestFocus).toHaveBeenLastCalledWith("pane-1");
    expect(observedLayouts).toEqual([["pane-1"], undefined]);
  });

  it("switches maximize spotlight to an addressed hidden pane", () => {
    const deck = deckWith({ select: "pane-1", focus: ["pane-1"] });
    const actions = viewActions(deck, { requestFocus: vi.fn() });

    actions.revealPane("ws-1", "pane-2");

    expect(deck.getSnapshot().viewByWs["ws-1"]).toEqual({
      teamOpen: "team-1",
      select: "pane-1",
      focus: ["pane-2"],
    });
  });

  it("a reveal into another team neither takes nor drops the spotlight the open team left", () => {
    // pane-1 is team-1's spotlight, which says nothing about team-2's grid:
    // pane-2 is revealed plain, and team-1 is still maximized to come back to.
    const deck = deckWith({ select: "pane-1", focus: ["pane-1"] }, true);
    const actions = viewActions(deck, { requestFocus: vi.fn() });

    actions.revealPane("ws-1", "pane-2");

    expect(deck.getSnapshot().viewByWs["ws-1"]).toEqual({
      teamOpen: "team-2",
      select: "pane-2",
      focus: ["pane-1"],
    });
  });

  // One view per reason a pane can be off the grid. The Record is the point:
  // a reason added to the domain without a fixture here fails to compile,
  // and the reveal's exhaustive switch fails to compile without an action.
  const hiddenViews: Record<HideReason, WorkspaceView> = {
    minimized: { select: "pane-1", minimized: ["pane-2"] },
    suspendedTray: { select: "pane-1", suspendedTray: ["pane-2"] },
  };

  it.each(Object.keys(hiddenViews) as HideReason[])(
    "reveals a pane hidden by %s, and it is on screen afterwards",
    (reason) => {
      const deck = deckWith(hiddenViews[reason]);
      const actions = viewActions(deck, { requestFocus: vi.fn() });

      actions.revealPane("ws-1", "pane-2");

      const after = deck.getSnapshot();
      // The RAW marker is gone — checked on the list itself, not through the
      // reading, so a reading that stopped seeing this reason cannot pass
      // its own test.
      expect(after.viewByWs["ws-1"]?.[reason] ?? []).not.toContain("pane-2");
      expect(hiddenBy(after.viewByWs["ws-1"], "pane-2")).toEqual([]);
      expect(
        paneOnScreen(
          stagePanes(after.workspaces[0], after.viewByWs["ws-1"]),
          after.viewByWs["ws-1"],
          "pane-2",
        ),
      ).toBe(true);
    },
  );

  it("removes every placement marker from an addressed pane", () => {
    const deck = deckWith({
      select: "pane-1",
      focus: ["pane-1"],
      minimized: ["pane-2"],
      suspendedTray: ["pane-2"],
    });
    const actions = viewActions(deck, { requestFocus: vi.fn() });

    actions.revealPane("ws-1", "pane-2");

    expect(deck.getSnapshot().viewByWs["ws-1"]).toEqual({
      teamOpen: "team-1",
      select: "pane-2",
    });
  });
});
