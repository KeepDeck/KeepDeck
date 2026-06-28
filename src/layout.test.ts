import { describe, expect, it } from "vitest";
import { gridTracks, paneGrid } from "./layout";

describe("paneGrid", () => {
  it("packs common fleet sizes into a near-square grid", () => {
    expect(paneGrid(1)).toEqual({ columns: 1, rows: 1 });
    expect(paneGrid(2)).toEqual({ columns: 2, rows: 1 });
    expect(paneGrid(4)).toEqual({ columns: 2, rows: 2 });
    expect(paneGrid(6)).toEqual({ columns: 3, rows: 2 });
    expect(paneGrid(8)).toEqual({ columns: 3, rows: 3 });
  });

  it("stays landscape and never drops a pane", () => {
    for (let n = 1; n <= 16; n++) {
      const { columns, rows } = paneGrid(n);
      expect(columns).toBeGreaterThanOrEqual(rows);
      expect(columns * rows).toBeGreaterThanOrEqual(n);
    }
  });

  it("rejects non-positive or non-integer counts", () => {
    expect(() => paneGrid(0)).toThrow(RangeError);
    expect(() => paneGrid(-3)).toThrow(RangeError);
    expect(() => paneGrid(2.5)).toThrow(RangeError);
  });
});

describe("gridTracks", () => {
  it("emits a CSS repeat() track list", () => {
    expect(gridTracks(3)).toBe("repeat(3, 1fr)");
  });
});
