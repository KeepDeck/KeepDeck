import { describe, expect, it } from "vitest";
import { paneAtPoint, type PaneRect, type Rect } from "./paneDnd";

describe("paneAtPoint", () => {
  const panes: PaneRect[] = [
    { id: "pane-1", rect: { left: 0, top: 0, right: 100, bottom: 100 } },
    { id: "pane-2", rect: { left: 100, top: 0, right: 200, bottom: 100 } },
    { id: "pane-3", rect: { left: 0, top: 100, right: 100, bottom: 200 } },
  ];
  /** Nothing over the deck — the docked dock takes a column and covers no pane. */
  const at = (x: number, y: number, blockers: Rect[] = []) =>
    paneAtPoint(x, y, { panes, blockers });

  it("returns the pane whose rect contains the point", () => {
    expect(at(150, 50)).toBe("pane-2");
    expect(at(50, 150)).toBe("pane-3");
  });

  it("treats the right/bottom edges as exclusive (the next pane owns them)", () => {
    expect(at(100, 50)).toBe("pane-2"); // x=100 is pane-2's left
    expect(at(50, 100)).toBe("pane-3"); // y=100 is pane-3's top
  });

  it("returns null for a point outside every pane", () => {
    expect(at(500, 500)).toBeNull();
    expect(at(-5, 10)).toBeNull();
  });

  describe("with chrome over the deck (a floating dock)", () => {
    // Covers the right half of pane-2 and nothing else.
    const dock: Rect = { left: 150, top: 0, right: 300, bottom: 200 };

    it("swallows a point it covers instead of passing it to the pane beneath", () => {
      // Uncovered, this point belongs to pane-2 — which is the whole bug: a
      // drop released on the dock would land in a pane the user cannot see
      // there and never aimed at.
      expect(at(160, 50)).toBe("pane-2");
      expect(at(160, 50, [dock])).toBeNull();
    });

    it("leaves the same pane reachable everywhere it is not covered", () => {
      // pane-2 spans 100..200; the dock starts at 150 and takes the rest.
      expect(at(120, 50, [dock])).toBe("pane-2");
      expect(at(149, 50, [dock])).toBe("pane-2");
      // A blocker owns its left edge, the way a pane owns its own.
      expect(at(150, 50, [dock])).toBeNull();
    });

    it("blocks by geometry, not by presence — panes it misses are untouched", () => {
      expect(at(50, 50, [dock])).toBe("pane-1");
      expect(at(50, 150, [dock])).toBe("pane-3");
    });

    it("still returns null where a blocker covers no pane at all", () => {
      expect(at(250, 150, [dock])).toBeNull();
    });
  });
});
