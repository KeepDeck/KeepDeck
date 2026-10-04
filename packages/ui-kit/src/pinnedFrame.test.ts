import { describe, expect, it } from "vitest";
import { pinnedFrame } from "./pinnedFrame";

describe("pinnedFrame — the pinned heading at a scroll offset", () => {
  // Rows 20 tall; the pinned heading is 20 tall.
  const rows = Array.from({ length: 10 }, (_, index) => ({ index, start: index * 20, end: index * 20 + 20 }));
  // Rows 0 and 5 head groups.
  const heads = (index: number) => index === 0 || index === 5;

  it("heads the group of the first row any part of which is in view", () => {
    expect(pinnedFrame(rows, 50, 20, heads).first).toBe(2);
    expect(pinnedFrame(rows, 59, 20, heads).first).toBe(2);
    expect(pinnedFrame(rows, 60, 20, heads).first).toBe(3);
    expect(pinnedFrame(rows, 500, 20, heads)).toEqual({ first: -1, shift: 0 });
  });

  it("stays put while the next heading is a heading's height or more below the top", () => {
    expect(pinnedFrame(rows, 50, 20, heads).shift).toBe(0);
    expect(pinnedFrame(rows, 80, 20, heads).shift).toBe(0);
  });

  it("goes up by exactly the part the next heading has run into it", () => {
    // Row 5 starts at 100: 15 below a top of 85, 5 into the pinned 20.
    expect(pinnedFrame(rows, 85, 20, heads).shift).toBe(-5);
    expect(pinnedFrame(rows, 99, 20, heads).shift).toBe(-19);
  });

  it("is not pushed by its own heading, nor when no heading follows", () => {
    // The first row in view IS the heading, its rows open below it.
    expect(pinnedFrame(rows, 100, 20, heads).shift).toBe(0);
    expect(pinnedFrame(rows, 50, 20, () => false).shift).toBe(0);
  });

  it("rides up with its own heading when the next group's heading follows it at once (folded groups)", () => {
    // Rows 5 and 6 both head groups: 5 is folded, 6 right under it.
    const folded = (index: number) => index === 5 || index === 6;
    expect(pinnedFrame(rows, 105, 20, folded)).toEqual({ first: 5, shift: -5 });
  });
});
