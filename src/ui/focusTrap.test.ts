// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
// @vitest-environment happy-dom
import { tabStops, trappedTab } from "./focusTrap";

describe("trappedTab — Tab inside a modal layer", () => {
  it("wraps at the ends, and lets the browser step in between", () => {
    expect(trappedTab(3, 2, false)).toBe(0);
    expect(trappedTab(3, 0, true)).toBe(2);
    expect(trappedTab(3, 1, false)).toBeNull();
    expect(trappedTab(3, 1, true)).toBeNull();
  });

  it("keeps a single stop — a palette's field — where it is", () => {
    expect(trappedTab(1, 0, false)).toBe(0);
    expect(trappedTab(1, 0, true)).toBe(0);
  });

  it("brings the keyboard in from outside, and holds it where there is no stop", () => {
    expect(trappedTab(3, -1, false)).toBe(0);
    expect(trappedTab(3, -1, true)).toBe(2);
    expect(trappedTab(0, -1, false)).toBe(-1);
  });
});

describe("tabStops — what Tab reaches in a layer", () => {
  it("is every focusable in order, but what opted out of the Tab order or is disabled", () => {
    const layer = document.createElement("div");
    layer.innerHTML = `<input id="a"><button id="b" tabindex="-1"></button><button id="c" disabled></button><a id="d" href="#"></a><div id="e" tabindex="0"></div>`;
    expect(tabStops(layer).map((el) => el.id)).toEqual(["a", "d", "e"]);
  });
});
