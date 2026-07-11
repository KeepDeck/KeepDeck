import { describe, expect, it, vi } from "vitest";
import {
  overlayVisibility,
  setOverlayVisibility,
  subscribeOverlayVisibility,
} from "./overlayVisibility";

describe("overlayVisibility", () => {
  it("keeps a stable snapshot between changes and a new one after each", () => {
    const before = overlayVisibility();
    expect(overlayVisibility()).toBe(before);

    setOverlayVisibility("p:viewer", true);
    const after = overlayVisibility();
    expect(after).not.toBe(before);
    expect(after.get("p:viewer")).toBe(true);
    expect(overlayVisibility()).toBe(after); // stable until the next change
  });

  it("a same-value write is a no-op — no snapshot churn, no notification", () => {
    setOverlayVisibility("p:same", false);
    const snapshot = overlayVisibility();
    const listener = vi.fn();
    const unsubscribe = subscribeOverlayVisibility(listener);
    setOverlayVisibility("p:same", false);
    expect(overlayVisibility()).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("notifies subscribers per real change and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOverlayVisibility(listener);
    setOverlayVisibility("p:toggling", true);
    setOverlayVisibility("p:toggling", false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setOverlayVisibility("p:toggling", true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
