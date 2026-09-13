import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anyOverlayCovers,
  clearOverlayCover,
  setOverlayCover,
  subscribeOverlayCover,
} from "./overlayCover";

afterEach(() => {
  clearOverlayCover("p");
  clearOverlayCover("q");
});

describe("overlayCover", () => {
  it("is one boolean: any covering overlay counts, none means clear", () => {
    expect(anyOverlayCovers()).toBe(false);
    setOverlayCover("p:diff", true);
    expect(anyOverlayCovers()).toBe(true);
    setOverlayCover("q:viewer", true);
    setOverlayCover("p:diff", false);
    // The other plugin's peek is still up.
    expect(anyOverlayCovers()).toBe(true);
    setOverlayCover("q:viewer", false);
    expect(anyOverlayCovers()).toBe(false);
  });

  it("notifies on a change of the answer only, not on every write", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOverlayCover(listener);
    setOverlayCover("p:diff", true);
    setOverlayCover("p:diff", true); // same word twice
    setOverlayCover("q:viewer", true); // answer already true
    expect(listener).toHaveBeenCalledTimes(1);
    setOverlayCover("p:diff", false); // still covered by q
    expect(listener).toHaveBeenCalledTimes(1);
    setOverlayCover("q:viewer", false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("a plugin's lifecycle flip forgets its overlays — the deck must not stay paused", () => {
    setOverlayCover("p:diff", true);
    setOverlayCover("q:viewer", true);
    clearOverlayCover("p");
    expect(anyOverlayCovers()).toBe(true);
    clearOverlayCover("q");
    expect(anyOverlayCovers()).toBe(false);
  });
});
