import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  gridTracks,
  paneColumnSpan,
  paneGrid,
  paneGridTrackColumns,
} from "./layout";

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

describe("paneColumnSpan", () => {
  it("stretches a lone last-row pane across the whole row", () => {
    // 7 panes -> 3 cols, last row has only index 6.
    expect(paneColumnSpan(6, 7)).toBe(paneGridTrackColumns(7));
  });

  it("splits a partial last row into EQUAL widths", () => {
    // 8 panes -> 3 cols x 3 rows; last row (6, 7) each takes half the width.
    const total = paneGridTrackColumns(8);
    expect(paneColumnSpan(6, 8)).toBe(total / 2);
    expect(paneColumnSpan(7, 8)).toBe(total / 2);
    // 5 panes -> 3 cols x 2 rows; last row (3, 4) also equal halves.
    const total5 = paneGridTrackColumns(5);
    expect(paneColumnSpan(3, 5)).toBe(total5 / 2);
    expect(paneColumnSpan(4, 5)).toBe(total5 / 2);
  });

  it("gives every pane in a row the same span (equal width)", () => {
    for (let n = 1; n <= MAX_PANES; n++) {
      const { columns, rows } = paneGrid(n);
      const lastRowStart = columns * (rows - 1);
      const fullRow = Array.from({ length: lastRowStart }, (_, i) =>
        paneColumnSpan(i, n),
      );
      const lastRow = Array.from({ length: n - lastRowStart }, (_, k) =>
        paneColumnSpan(lastRowStart + k, n),
      );
      expect(new Set(fullRow).size).toBeLessThanOrEqual(1);
      expect(new Set(lastRow).size).toBe(1);
    }
  });

  it("makes every row's spans sum to the track-column count", () => {
    for (let n = 1; n <= MAX_PANES; n++) {
      const total = paneGridTrackColumns(n);
      const { columns, rows } = paneGrid(n);
      const lastRowStart = columns * (rows - 1);
      if (lastRowStart > 0) {
        let fullSum = 0;
        for (let i = 0; i < columns; i++) fullSum += paneColumnSpan(i, n);
        expect(fullSum).toBe(total);
      }
      let lastSum = 0;
      for (let i = lastRowStart; i < n; i++) lastSum += paneColumnSpan(i, n);
      expect(lastSum).toBe(total);
    }
  });
});
