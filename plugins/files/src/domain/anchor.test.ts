import { describe, expect, it } from "vitest";
import { rowAtViewportTop } from "./anchor";

/** Rows 20 tall, starting at 0 — bottoms at 20, 40, 60, … */
const bottoms = (count: number) =>
  Array.from({ length: count }, (_, i) => i * 20 + 20);

describe("rowAtViewportTop", () => {
  it("picks the row the reader is on, not the first one fully below", () => {
    // Viewport top at 100 cuts row 5 (bottom 120) in half — that is the row
    // being read, so it is the anchor, not row 6.
    expect(rowAtViewportTop(bottoms(40), 100)).toBe(5);
  });

  it("a row whose bottom sits exactly on the fold is already gone", () => {
    // Row 4's bottom is 100: nothing of it is on screen.
    expect(rowAtViewportTop(bottoms(40), 100)).not.toBe(4);
    expect(rowAtViewportTop(bottoms(40), 99)).toBe(4);
  });

  it("the top of the list anchors on the first row", () => {
    expect(rowAtViewportTop(bottoms(40), 0)).toBe(0);
    // Scrolled up past the content (rubber-banding gives a negative top).
    expect(rowAtViewportTop(bottoms(40), -50)).toBe(0);
  });

  it("past the last row the place is the LAST row, not the first", () => {
    // Every row ends above the viewport. Answering 0 would throw a reader at
    // the end of the file back to line one.
    expect(rowAtViewportTop(bottoms(40), 10_000)).toBe(39);
  });

  it("no rows at all still yields a usable index", () => {
    expect(rowAtViewportTop([], 100)).toBe(0);
  });
});
