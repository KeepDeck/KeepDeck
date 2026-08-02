import { describe, expect, it, vi } from "vitest";
import { createPaneViewActions } from "./paneViewActions";

describe("PaneViewActions", () => {
  it("requests terminal focus after every maximize transition", () => {
    const order: string[] = [];
    const toggleMaximize = vi.fn(() => order.push("layout"));
    const requestFocus = vi.fn(() => order.push("focus"));
    const actions = createPaneViewActions(toggleMaximize, { requestFocus });

    actions.toggleMaximize("ws-1", "pane-1");
    actions.toggleMaximize("ws-1", "pane-1");

    expect(toggleMaximize).toHaveBeenCalledTimes(2);
    expect(toggleMaximize).toHaveBeenLastCalledWith("ws-1", "pane-1");
    expect(requestFocus).toHaveBeenCalledTimes(2);
    expect(requestFocus).toHaveBeenLastCalledWith("pane-1");
    expect(order).toEqual(["layout", "focus", "layout", "focus"]);
  });
});
