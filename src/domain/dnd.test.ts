import { describe, expect, it } from "vitest";
import { paneAtPoint, type PaneRect } from "./dnd";

describe("paneAtPoint", () => {
  const rects: PaneRect[] = [
    { id: "pane-1", rect: { left: 0, top: 0, right: 100, bottom: 100 } },
    { id: "pane-2", rect: { left: 100, top: 0, right: 200, bottom: 100 } },
    { id: "pane-3", rect: { left: 0, top: 100, right: 100, bottom: 200 } },
  ];

  it("returns the pane whose rect contains the point", () => {
    expect(paneAtPoint(150, 50, rects)).toBe("pane-2");
    expect(paneAtPoint(50, 150, rects)).toBe("pane-3");
  });

  it("treats the right/bottom edges as exclusive (the next pane owns them)", () => {
    expect(paneAtPoint(100, 50, rects)).toBe("pane-2"); // x=100 is pane-2's left
    expect(paneAtPoint(50, 100, rects)).toBe("pane-3"); // y=100 is pane-3's top
  });

  it("returns null for a point outside every pane", () => {
    expect(paneAtPoint(500, 500, rects)).toBeNull();
    expect(paneAtPoint(-5, 10, rects)).toBeNull();
  });
});
