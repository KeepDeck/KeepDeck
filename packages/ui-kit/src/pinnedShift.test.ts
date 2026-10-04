import { describe, expect, it } from "vitest";
import { pinnedShift } from "./pinnedShift";

describe("pinnedShift — the next heading pushes the pinned one out", () => {
  // Rows 20 tall; rows 0 and 5 head groups; the pinned heading is 20 tall.
  const rows = Array.from({ length: 10 }, (_, index) => ({ index, start: index * 20 }));
  const heads = (index: number) => index === 0 || index === 5;

  it("stays put while the next heading is a heading's height or more below the top", () => {
    expect(pinnedShift(rows, 2, 50, 20, heads)).toBe(0);
    expect(pinnedShift(rows, 3, 80, 20, heads)).toBe(0);
  });

  it("goes up by exactly the part the next heading has run into it", () => {
    // Row 5 starts at 100: 15 below a top of 85, 5 into the pinned 20.
    expect(pinnedShift(rows, 4, 85, 20, heads)).toBe(-5);
    expect(pinnedShift(rows, 4, 99, 20, heads)).toBe(-19);
  });

  it("is not pushed by its own group's heading, nor by nothing", () => {
    // The first row in view IS the heading: the next is past the window.
    expect(pinnedShift(rows, 5, 100, 20, heads)).toBe(0);
    expect(pinnedShift(rows, 2, 50, 20, () => false)).toBe(0);
  });
});
