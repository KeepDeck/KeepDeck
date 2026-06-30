// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  collectRailItemRects,
  railItemAtY,
  type RailItemRect,
} from "./railDnd";

describe("railItemAtY", () => {
  const rects: RailItemRect[] = [
    { id: "a", top: 0, bottom: 30 },
    { id: "b", top: 30, bottom: 60 },
    { id: "c", top: 60, bottom: 90 },
  ];

  it("returns the item whose vertical span contains the point", () => {
    expect(railItemAtY(15, rects)).toBe("a");
    expect(railItemAtY(45, rects)).toBe("b");
    expect(railItemAtY(75, rects)).toBe("c");
  });

  it("treats the bottom edge as the next item's (top-inclusive spans)", () => {
    expect(railItemAtY(30, rects)).toBe("b"); // y == a.bottom == b.top
    expect(railItemAtY(60, rects)).toBe("c");
  });

  it("clamps past either end to the nearest item", () => {
    expect(railItemAtY(-100, rects)).toBe("a"); // above the first
    expect(railItemAtY(1000, rects)).toBe("c"); // below the last
  });

  it("returns null when there are no items", () => {
    expect(railItemAtY(10, [])).toBeNull();
  });
});

describe("collectRailItemRects (real DOM)", () => {
  it("reads id + vertical extent from [data-ws-id] children, in order", () => {
    document.body.innerHTML = `
      <ul id="list">
        <li data-ws-id="ws-1"></li>
        <li class="rail__item" data-ws-id="ws-2"></li>
        <li>no id — skipped</li>
      </ul>`;
    const list = document.getElementById("list")!;
    const rects = collectRailItemRects(list);
    expect(rects.map((r) => r.id)).toEqual(["ws-1", "ws-2"]);
    // happy-dom returns 0-rects, but the shape (top/bottom numbers) must hold.
    for (const r of rects) {
      expect(typeof r.top).toBe("number");
      expect(typeof r.bottom).toBe("number");
    }
  });
});
