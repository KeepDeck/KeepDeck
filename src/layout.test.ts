import { describe, expect, it } from "vitest";
import { MAX_PANES, gridTracks, paneGrid } from "./layout";

describe("paneGrid", () => {
  it("uses square-driven columns and only as many rows as needed", () => {
    expect(paneGrid(1)).toEqual({ columns: 1, rows: 1 });
    expect(paneGrid(2)).toEqual({ columns: 2, rows: 1 });
    expect(paneGrid(4)).toEqual({ columns: 2, rows: 2 });
    expect(paneGrid(5)).toEqual({ columns: 3, rows: 2 });
    expect(paneGrid(9)).toEqual({ columns: 3, rows: 3 });
    expect(paneGrid(10)).toEqual({ columns: 4, rows: 3 });
    expect(paneGrid(16)).toEqual({ columns: 4, rows: 4 });
  });

  it("never reserves an empty trailing row and never drops a pane", () => {
    for (let n = 1; n <= MAX_PANES; n++) {
      const { columns, rows } = paneGrid(n);
      expect(columns * rows).toBeGreaterThanOrEqual(n);
      // Removing the last row would no longer fit all panes — i.e. no empty row.
      expect(columns * (rows - 1)).toBeLessThan(n);
    }
  });

  it("rejects counts outside 1..=MAX_PANES or non-integers", () => {
    expect(() => paneGrid(0)).toThrow(RangeError);
    expect(() => paneGrid(-3)).toThrow(RangeError);
    expect(() => paneGrid(2.5)).toThrow(RangeError);
    expect(() => paneGrid(MAX_PANES + 1)).toThrow(RangeError);
  });
});

describe("gridTracks", () => {
  it("emits a CSS repeat() track list", () => {
    expect(gridTracks(3)).toBe("repeat(3, 1fr)");
  });
});
