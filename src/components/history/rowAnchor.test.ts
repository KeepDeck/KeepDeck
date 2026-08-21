import { describe, expect, it } from "vitest";
import { anchorCorrection, pickAnchor, type AnchorRow } from "./rowAnchor";

// The anchor DECISION arithmetic, verified directly — numbers, not
// pixels. The stand computes no geometry; the DOM half (applying the
// delta to scrollTop) is the browser's and stays the user's witness.
// The scenario this file exists for: a landed WORKSPACE page inserts
// rows ABOVE a watched other-row; the row's INDEX shifts by the page
// size, its KEY does not.
describe("rowAnchor — the insertion-above correction", () => {
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
  });

  it("a workspace page landing ABOVE the watched row: the SAME key keeps its offset — delta exactly the inserted span", () => {
    // Watched g-5 at offset 0 from the scroll top (start 320 = scrollTop).
    const prev = { key: "g-5", offset: 0 };
    // 20 workspace rows of 64px land ABOVE: g-5's start moves to
    // 320 + 20*64 = 1600; the scrollTop has not moved yet (320).
    const after = Array.from({ length: 26 }, (_, i) =>
      row(i < 20 ? `w-${i}` : `g-${i - 20}`, i * 64),
    );
    const { delta, next } = anchorCorrection(after, 320, prev);
    // Shift the scroll by EXACTLY the inserted span: g-5 stays at
    // offset 0. An INDEX-anchored hold would have computed 0 here
    // (index 5 still "visible") and let the watched row jump 20 rows.
    expect(delta).toBe(20 * 64);
    expect(next).toEqual(prev);
  });

  it("insertions BELOW the watched row change nothing — delta 0", () => {
    const prev = { key: "g-5", offset: 0 };
    // The queue grows AFTER the anchor: g-5's start is untouched.
    const after = [row("g-5", 320), row("g-6", 384), row("g-new", 448)];
    const { delta, next } = anchorCorrection(after, 320, prev);
    expect(delta).toBe(0);
    expect(next).toEqual(prev);
  });

  it("VANISHED KEY holds the current offset and re-anchors — no jump to the top", () => {
    // The watched key left the queue (search, scope, invalidation):
    // whatever now occupies the viewport stays; the next first-visible
    // row becomes the anchor. A delta ≠ 0 here would decide FOR the
    // user in the one moment we do not know what happened.
    const prev = { key: "gone", offset: 12 };
    const after = [row("n-0", 300), row("n-1", 364)];
    const { delta, next } = anchorCorrection(after, 320, prev);
    expect(delta).toBe(0);
    expect(next).toEqual({ key: "n-1", offset: 364 - 320 });
  });

  it("a size change ABOVE the watched row is corrected by the same arithmetic", () => {
    // The library corrects its own sizes; this covers the case it
    // hands to us: the row above grew 10px, the watched row's start
    // moved +10 while the scroll stood.
    const prev = { key: "g-5", offset: 0 };
    const after = [row("g-4", 256), row("g-5", 330)];
    const { delta } = anchorCorrection(after, 320, prev);
    expect(delta).toBe(10);
  });
});
