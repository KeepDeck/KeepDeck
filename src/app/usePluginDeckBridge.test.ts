import { describe, expect, it, vi } from "vitest";
import { closedWorkspaceIds, revealDockTabOn } from "./usePluginDeckBridge";

describe("closedWorkspaceIds", () => {
  it("names exactly the ids that disappeared", () => {
    expect(closedWorkspaceIds(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
  });

  it("is empty on growth, reorder, and the first render", () => {
    expect(closedWorkspaceIds([], ["a"])).toEqual([]);
    expect(closedWorkspaceIds(["a", "b"], ["b", "a", "c"])).toEqual([]);
  });

  it("reports several removals at once (multi-close on hydrate)", () => {
    expect(closedWorkspaceIds(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });
});

describe("revealDockTabOn", () => {
  const deckWith = (dock: boolean | undefined, activeId = "ws-1") => ({
    activeId,
    viewOf: vi.fn(() => ({ dock })),
    toggleDock: vi.fn(),
    setDockTab: vi.fn(),
  });

  it("opens a closed dock, then selects the tab", () => {
    const deck = deckWith(undefined);
    revealDockTabOn(deck, "keepdeck.files:files");
    expect(deck.toggleDock).toHaveBeenCalledWith("ws-1");
    expect(deck.setDockTab).toHaveBeenCalledWith("ws-1", "keepdeck.files:files");
  });

  it("leaves an already-open dock alone — toggle would CLOSE it", () => {
    const deck = deckWith(true);
    revealDockTabOn(deck, "keepdeck.files:files");
    expect(deck.toggleDock).not.toHaveBeenCalled();
    expect(deck.setDockTab).toHaveBeenCalledWith("ws-1", "keepdeck.files:files");
  });

  it("does nothing without an active workspace", () => {
    const deck = deckWith(undefined, "");
    revealDockTabOn(deck, "t");
    expect(deck.toggleDock).not.toHaveBeenCalled();
    expect(deck.setDockTab).not.toHaveBeenCalled();
  });
});
