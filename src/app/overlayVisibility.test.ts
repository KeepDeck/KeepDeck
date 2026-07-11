import { describe, expect, it, vi } from "vitest";
import {
  clearOverlayVisibility,
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

  it("clear forgets ONE plugin's keys — a restarted iframe overlay returns HIDDEN", () => {
    setOverlayVisibility("mine:viewer", true);
    setOverlayVisibility("mine:second", false);
    setOverlayVisibility("other:viewer", true);

    clearOverlayVisibility("mine");
    expect(overlayVisibility().get("mine:viewer")).toBeUndefined();
    expect(overlayVisibility().get("mine:second")).toBeUndefined();
    // The neighbour's choices survive; so does prefix hygiene ("mine" must
    // not eat "mine2:*"-style ids — the separator is part of the match).
    expect(overlayVisibility().get("other:viewer")).toBe(true);

    // Clearing a plugin with no keys changes (and notifies) nothing.
    const snapshot = overlayVisibility();
    const listener = vi.fn();
    const unsubscribe = subscribeOverlayVisibility(listener);
    clearOverlayVisibility("mine");
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
