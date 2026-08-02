import { describe, expect, it, vi } from "vitest";
import { initialDeckState, type WorkspaceView } from "../domain/deck";
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
