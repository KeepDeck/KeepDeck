import { describe, expect, it, vi } from "vitest";
import {
  hiddenBy,
  initialDeckState,
  paneOnScreen,
  type HideReason,
  type WorkspaceView,
} from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createDeckStore } from "../app/deckStore";
import { createPaneViewActions } from "./paneViewActions";

const deckWith = (view: WorkspaceView = {}) =>
  createDeckStore({
    ...initialDeckState,
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "Workspace",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1" }, { id: "pane-2" }],
      },
    ],
    activeId: "ws-1",
    viewByWs: { "ws-1": view },
  });

describe("PaneViewActions", () => {
  it("requests terminal focus after every maximize transition", () => {
    const deck = deckWith({ select: "pane-1" });
    const observedLayouts: Array<string | undefined> = [];
    const requestFocus = vi.fn(() =>
      observedLayouts.push(deck.getSnapshot().viewByWs["ws-1"]?.focus),
    );
    const actions = createPaneViewActions(deck, { requestFocus });

    actions.toggleMaximize("ws-1", "pane-1");
    actions.toggleMaximize("ws-1", "pane-1");

    expect(requestFocus).toHaveBeenCalledTimes(2);
    expect(requestFocus).toHaveBeenLastCalledWith("pane-1");
    expect(observedLayouts).toEqual(["pane-1", undefined]);
  });

  it("switches maximize spotlight to an addressed hidden pane", () => {
    const deck = deckWith({ select: "pane-1", focus: "pane-1" });
    const actions = createPaneViewActions(deck, { requestFocus: vi.fn() });

    actions.revealPane("ws-1", "pane-2");

    expect(deck.getSnapshot().viewByWs["ws-1"]).toEqual({
      select: "pane-1",
      focus: "pane-2",
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
      const actions = createPaneViewActions(deck, { requestFocus: vi.fn() });

      actions.revealPane("ws-1", "pane-2");

      const after = deck.getSnapshot();
      // The RAW marker is gone — checked on the list itself, not through the
      // reading, so a reading that stopped seeing this reason cannot pass
      // its own test.
      expect(after.viewByWs["ws-1"]?.[reason] ?? []).not.toContain("pane-2");
      expect(hiddenBy(after.viewByWs["ws-1"], "pane-2")).toEqual([]);
      expect(paneOnScreen(after.workspaces[0].panes, after.viewByWs["ws-1"], "pane-2")).toBe(
        true,
      );
    },
  );

  it("removes every placement marker from an addressed pane", () => {
    const deck = deckWith({
      select: "pane-1",
      focus: "pane-1",
      minimized: ["pane-2"],
      suspendedTray: ["pane-2"],
    });
    const actions = createPaneViewActions(deck, { requestFocus: vi.fn() });

    actions.revealPane("ws-1", "pane-2");

    expect(deck.getSnapshot().viewByWs["ws-1"]).toEqual({
      select: "pane-2",
    });
  });
});
