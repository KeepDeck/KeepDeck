// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YoloBadge } from "../ui/badges";
import { appCss } from "./testSupport";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let sheet: HTMLStyleElement;

beforeEach(() => {
  sheet = document.createElement("style");
  sheet.textContent = appCss;
  document.head.append(sheet);
  document.body.innerHTML = "<div id='host'></div>";
  host = document.getElementById("host")!;
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  sheet.remove();
});

describe("icon-only chip", () => {
  it("draws a real circle at both sizes", () => {
    // Through the shipped component and the shipped stylesheet, because the
    // bug being kept out is a chip that LOOKS like a badge in markup and lands
    // as a stadium on screen: a 999px radius only reads as a circle while the
    // box is square, which means the side padding must be gone and the width
    // must equal the chip's own height.
    // Square is asserted as width === height rather than against a literal:
    // repeating 22 and 20 here is what --chip-diameter exists to stop, and a
    // literal would fail on a density change with a message that reads like a
    // stale expectation, inviting the number to be updated instead of the bug
    // to be found.
    const seen = new Set<string>();
    for (const size of [undefined, "sm"] as const) {
      act(() => root.render(createElement(YoloBadge, { size })));
      const badge = getComputedStyle(host.querySelector(".yolo-badge")!);
      const label = size ?? "md";
      expect(badge.width, `${label} has no width`).toMatch(/^\d+px$/);
      expect(badge.height, `${label} is not square`).toBe(badge.width);
      expect(badge.paddingLeft).toBe("0px");
      expect(badge.paddingRight).toBe("0px");
      expect(badge.justifyContent).toBe("center");
      expect(badge.borderRadius).toBe("999px");
      seen.add(badge.width);
    }
    // Both sizes really resolved — one token feeding both would otherwise let
    // `sm` silently stop being smaller while every assertion above passed.
    expect(seen.size, "md and sm draw the same diameter").toBe(2);
  });
});
