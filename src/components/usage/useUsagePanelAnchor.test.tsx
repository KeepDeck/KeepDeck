// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUsagePanelAnchor } from "./useUsagePanelAnchor";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Geometry the test states on each element, since happy-dom lays nothing
 *  out: `data-x` is the element's left edge, `data-w` its width. */
function stubGeometry() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const el = this as HTMLElement;
      const left = Number(el.dataset.x ?? 0);
      const width = Number(el.dataset.w ?? 0);
      return { left, width, right: left + width, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    },
  );
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1400,
    configurable: true,
  });
}

/** One chip row with a panel in it, positioned by the props. */
function Harness({
  openProvider,
  chips,
}: {
  openProvider: string | null;
  /** id → left edge, in the order they are drawn. */
  chips: readonly (readonly [string, number])[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rosterKey = chips.map(([id]) => id).join("\n");
  const left = useUsagePanelAnchor(ref, openProvider, rosterKey);
  return createElement(
    "div",
    { ref, "data-x": "500", "data-w": "400", "data-left": String(left) },
    ...chips.map(([id, x]) =>
      createElement("span", { key: id, "data-usage-chip": id, "data-x": String(x), "data-w": "80" }),
    ),
    openProvider !== null &&
      createElement("div", { className: "usage-panel", "data-x": "0", "data-w": "320" }),
  );
}

describe("useUsagePanelAnchor", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    stubGeometry();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
  });

  const render = (props: Parameters<typeof Harness>[0]) =>
    act(() => root.render(createElement(Harness, props)));
  const left = () => host.querySelector("div")!.dataset.left;

  it("hangs the panel from the chip that opened it", () => {
    // Group at 500, chip at 620 — 120 along from the group's own left edge.
    render({ openProvider: "b", chips: [["a", 500], ["b", 620]] });
    expect(left()).toBe("120");
  });

  it("follows the chip when a new one appears beside it", () => {
    // THE bug: the open provider does not change, so an effect watching only
    // that never re-measures. But an agent starting shifts every chip after
    // it along, and the panel is anchored to a chip, not to a place.
    render({ openProvider: "b", chips: [["b", 500]] });
    expect(left()).toBe("0");
    render({ openProvider: "b", chips: [["a", 500], ["b", 620]] });
    expect(left()).toBe("120");
  });

  it("gives up the alignment rather than the panel at the window's edge", () => {
    // Chip at 1340 would trail a 320-wide panel off a 1400-wide window.
    render({ openProvider: "b", chips: [["b", 1340]] });
    expect(left()).toBe("572"); // 1400 − 8 − 320 = 1072, i.e. 572 past the group
  });

  it("forgets where it was once the panel closes", () => {
    render({ openProvider: "b", chips: [["a", 500], ["b", 620]] });
    expect(left()).toBe("120");
    render({ openProvider: null, chips: [["a", 500], ["b", 620]] });
    expect(left()).toBe("null");
  });
});
