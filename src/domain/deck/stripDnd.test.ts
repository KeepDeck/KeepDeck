import { describe, expect, it } from "vitest";
import { markAtY, type MarkRect } from "./stripDnd";

describe("markAtY", () => {
  const rects: MarkRect[] = [
    { id: "a", top: 0, bottom: 30 },
    { id: "b", top: 30, bottom: 60 },
    { id: "c", top: 60, bottom: 90 },
  ];

  it("returns the item whose vertical span contains the point", () => {
    expect(markAtY(15, rects)).toBe("a");
    expect(markAtY(45, rects)).toBe("b");
    expect(markAtY(75, rects)).toBe("c");
  });

  it("treats the bottom edge as the next item's (top-inclusive spans)", () => {
    expect(markAtY(30, rects)).toBe("b"); // y == a.bottom == b.top
    expect(markAtY(60, rects)).toBe("c");
  });

  it("clamps past either end to the nearest item", () => {
    expect(markAtY(-100, rects)).toBe("a"); // above the first
    expect(markAtY(1000, rects)).toBe("c"); // below the last
  });

  it("returns null when there are no items", () => {
    expect(markAtY(10, [])).toBeNull();
  });
});
