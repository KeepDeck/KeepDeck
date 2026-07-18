import { describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { closedWorkspaces, revealDockTabOn } from "./usePluginDeckBridge";

const ref = (id: string, instance = createWorkspaceInstance()) => ({
  id,
  instance,
});

describe("closedWorkspaces", () => {
  it("names exactly the ids that disappeared", () => {
    const a = ref("a");
    const b = ref("b");
    const c = ref("c");
    expect(closedWorkspaces([a, b, c], [a, c])).toEqual([b]);
  });

  it("is empty on growth, reorder, and the first render", () => {
    const a = ref("a");
    const b = ref("b");
    expect(closedWorkspaces([], [a])).toEqual([]);
    expect(closedWorkspaces([a, b], [b, a, ref("c")])).toEqual([]);
  });

  it("reports several removals at once (multi-close on hydrate)", () => {
    const previous = [ref("a"), ref("b"), ref("c")];
    expect(closedWorkspaces(previous, [])).toEqual(previous);
  });

  it("reports the old lifetime when the same public id is reused", () => {
    const old = ref("ws-3");
    expect(closedWorkspaces([old], [ref("ws-3")])).toEqual([old]);
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
