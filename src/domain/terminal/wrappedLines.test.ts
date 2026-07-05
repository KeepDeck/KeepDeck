import { describe, it, expect } from "vitest";
import {
  logicalLineAt,
  mapRange,
  MAX_LOGICAL_ROWS,
  type WrappedBufferLike,
} from "./wrappedLines";
import { detectLinks } from "./links";

/**
 * Fake buffer over `{ text, wrapped }` rows. Mirrors xterm's IBufferLine
 * contract: `translateToString(true)` right-trims, `false` keeps the row as
 * stored (a wrapped-at row is full to the terminal width, spaces included).
 */
const buffer = (rows: { text: string; wrapped?: boolean }[]): WrappedBufferLike => ({
  getLine: (y) =>
    y >= 0 && y < rows.length
      ? {
          isWrapped: rows[y].wrapped === true,
          translateToString: (trimRight: boolean) =>
            trimRight ? rows[y].text.replace(/\s+$/, "") : rows[y].text,
        }
      : undefined,
});

describe("logicalLineAt", () => {
  it("returns a plain unwrapped row as its own logical line", () => {
    const buf = buffer([{ text: "hello  " }]);
    expect(logicalLineAt(buf, 0)).toEqual({ startRow: 0, rows: ["hello"] });
  });

  it("is null outside the buffer", () => {
    expect(logicalLineAt(buffer([{ text: "x" }]), 5)).toBeNull();
  });

  it("collects the same logical line from its head, middle and tail rows", () => {
    const buf = buffer([
      { text: "before" },
      { text: "aaaa" },
      { text: "bbbb", wrapped: true },
      { text: "cc", wrapped: true },
      { text: "after" },
    ]);
    const expected = { startRow: 1, rows: ["aaaa", "bbbb", "cc"] };
    expect(logicalLineAt(buf, 1)).toEqual(expected);
    expect(logicalLineAt(buf, 2)).toEqual(expected);
    expect(logicalLineAt(buf, 3)).toEqual(expected);
  });

  it("keeps a genuine space at the wrap column on non-final rows", () => {
    // "error in " wrapped right after its trailing space: trimming it would
    // glue the words into "in/tmp/x.txt" and break path detection.
    const buf = buffer([
      { text: "error in " },
      { text: "/tmp/x.txt  ", wrapped: true },
    ]);
    const logical = logicalLineAt(buf, 0)!;
    expect(logical.rows).toEqual(["error in ", "/tmp/x.txt"]);
    expect(detectLinks(logical.rows.join("")).map((l) => l.text)).toEqual([
      "/tmp/x.txt",
    ]);
  });

  it("stops extending past the row cap", () => {
    const rows = [{ text: "r0" }].concat(
      Array.from({ length: MAX_LOGICAL_ROWS + 10 }, () => ({
        text: "cont",
        wrapped: true,
      })),
    );
    const logical = logicalLineAt(buffer(rows), 0)!;
    expect(logical.rows.length).toBe(MAX_LOGICAL_ROWS);
  });

  it("always includes the requested row even when the cap truncates upward", () => {
    const rows = [{ text: "r0" }].concat(
      Array.from({ length: MAX_LOGICAL_ROWS + 10 }, () => ({
        text: "cont",
        wrapped: true,
      })),
    );
    const requested = MAX_LOGICAL_ROWS + 5;
    const logical = logicalLineAt(buffer(rows), requested)!;
    expect(logical.startRow).toBeGreaterThan(0);
    expect(logical.startRow).toBeLessThanOrEqual(requested);
    expect(logical.startRow + logical.rows.length - 1).toBeGreaterThanOrEqual(
      requested,
    );
  });
});

describe("mapRange", () => {
  const logical = { startRow: 4, rows: ["0123456789", "abcdefghij", "kl"] };

  it("maps a match inside a single later row", () => {
    // "cdef" = joined offsets 12..16 → row 1, string cols 2..5.
    expect(mapRange(logical, 12, 16)).toEqual({
      start: { x: 3, y: 6 },
      end: { x: 6, y: 6 },
    });
  });

  it("splits a match across the wrap boundary (the wrapped-link case)", () => {
    // "89abc" = offsets 8..13 → starts at row 0 col 8, ends at row 1 col 2.
    expect(mapRange(logical, 8, 13)).toEqual({
      start: { x: 9, y: 5 },
      end: { x: 3, y: 6 },
    });
  });

  it("keeps the inclusive end on the last char of a row", () => {
    // "ij" = offsets 18..20 → ends exactly on row 1's last column.
    expect(mapRange(logical, 18, 20)).toEqual({
      start: { x: 9, y: 6 },
      end: { x: 10, y: 6 },
    });
  });
});

describe("link detection over a joined logical line", () => {
  it("finds one whole URL where per-row scans saw fragments", () => {
    const buf = buffer([
      { text: "see https://example.com/very/lo" },
      { text: "ng/path/index.html now", wrapped: true },
    ]);
    const logical = logicalLineAt(buf, 1)!;
    const found = detectLinks(logical.rows.join(""));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "url",
      text: "https://example.com/very/long/path/index.html",
    });
    // And the range lands on both rows.
    const range = mapRange(logical, found[0].start, found[0].end);
    expect(range.start.y).toBe(1);
    expect(range.end.y).toBe(2);
  });

  it("finds a whole absolute path wrapped mid-segment", () => {
    const buf = buffer([
      { text: "at /Users/artem/Projects/Keep" },
      { text: "Deck/src/domain/links.ts:42 in", wrapped: true },
    ]);
    const logical = logicalLineAt(buf, 0)!;
    expect(detectLinks(logical.rows.join("")).map((l) => l.text)).toEqual([
      "/Users/artem/Projects/KeepDeck/src/domain/links.ts:42",
    ]);
  });
});
