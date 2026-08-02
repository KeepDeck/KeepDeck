import { describe, expect, it, vi } from "vitest";
import { createPaneInputFocusController } from "./paneInputFocusController";

describe("PaneInputFocusController", () => {
  it("publishes every request, including repeats for the same pane", () => {
    const controller = createPaneInputFocusController();
    const listener = vi.fn();
    controller.subscribe(listener);

    const initial = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(initial);

    controller.requestFocus("pane-1");
    expect(controller.getSnapshot()).toEqual({ paneId: "pane-1", version: 1 });
    controller.requestFocus("pane-1");
    expect(controller.getSnapshot()).toEqual({ paneId: "pane-1", version: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying an unsubscribed listener", () => {
    const controller = createPaneInputFocusController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    unsubscribe();
    controller.requestFocus("pane-1");

    expect(listener).not.toHaveBeenCalled();
  });

  it("becomes inert when disposed", () => {
    const controller = createPaneInputFocusController();
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.dispose();
    controller.requestFocus("pane-1");
    controller.subscribe(listener);

    expect(controller.getSnapshot()).toEqual({ paneId: null, version: 0 });
    expect(listener).not.toHaveBeenCalled();
  });
});
