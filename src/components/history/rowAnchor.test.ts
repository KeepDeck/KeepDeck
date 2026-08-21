import { describe, expect, it } from "vitest";
import { pickAnchor, type AnchorRow } from "./rowAnchor";

// The anchor's CHOICE, verified directly — numbers, not pixels. The
// stand computes no geometry; the compensation half (getOffsetForIndex
// over the full queue) is witnessed integratively in the browser
// suite — the full-queue lookup and the sameness invariant. The
// scenario this file exists for: a landed WORKSPACE page inserts rows
// ABOVE a watched other-row; the row's INDEX shifts by the page size,
// its KEY does not.
describe("rowAnchor — the anchor's choice", () => {
  const row = (key: string, start: number): AnchorRow => ({ key, start });

  it("the anchor is the first FULLY visible row by KEY — never an overscan row above", () => {
    // scrollTop 320; overscan rows at 128/192 sit ABOVE the viewport.
    const rows = [row("over-2", 128), row("over-1", 192), row("g-5", 320), row("g-6", 384)];
    expect(pickAnchor(rows, 320)?.key).toBe("g-5");
    // Unsorted input: order must not matter — the decision reads
    // positions, not array order.
    expect(pickAnchor([...rows].reverse(), 320)?.key).toBe("g-5");
    // Nothing visible yet (all above): no anchor.
    expect(pickAnchor([row("x", 0), row("y", 64)], 320)).toBeUndefined();
    // The EMPTY map (first open, nothing measured): no anchor — the
    // live effect holds the offset and re-arms later; an unmeasured
    // window is youth, not death, and must never read as a vanished
    // key (that reading would restore the jump).
    expect(pickAnchor([], 320)).toBeUndefined();
  });
});
