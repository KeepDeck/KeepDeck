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
    expect(logicalLineAt(buf, 0)).toEqual({
      startRow: 0,
      rows: ["hello"],
      indents: [0],
    });
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
    const expected = {
      startRow: 1,
      rows: ["aaaa", "bbbb", "cc"],
      indents: [0, 0, 0],
    };
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
  const logical = {
    startRow: 4,
    rows: ["0123456789", "abcdefghij", "kl"],
    indents: [0, 0, 0],
  };

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

describe("logicalLineAt — application hard wrap", () => {
  // A path the child app itself wrapped to width 10 with a 2-space hanging
  // indent — real newlines (no `wrapped` flag), full non-final rows. Mirrors the
  // Claude Code tree output in the bug report, shrunk.
  const cols = 10;
  const hardWrapped = () =>
    buffer([
      { text: "before it" },
      { text: "/aa/bb/ccc" }, // full to cols, ends mid-token
      { text: "  dd/ee/ff" }, // indent 2, resumes the token
      { text: "  gg.ts" }, // tail
      { text: "after all" },
    ]);
  const joined = "/aa/bb/cccdd/ee/ffgg.ts";

  it("stitches the same logical line from its head, middle and tail rows", () => {
    const expected = {
      startRow: 1,
      rows: ["/aa/bb/ccc", "dd/ee/ff", "gg.ts"],
      indents: [0, 2, 2],
    };
    for (const row of [1, 2, 3]) {
      expect(logicalLineAt(hardWrapped(), row, cols)).toEqual(expected);
    }
  });

  it("detects the whole path over the stitched line where per-row scans saw fragments", () => {
    const logical = logicalLineAt(hardWrapped(), 2, cols)!;
    expect(detectLinks(logical.rows.join("")).map((l) => l.text)).toEqual([
      joined,
    ]);
  });

  it("maps the link range back across the stripped indents", () => {
    const logical = logicalLineAt(hardWrapped(), 1, cols)!;
    const [link] = detectLinks(logical.rows.join(""));
    const range = mapRange(logical, link.start, link.end);
    // Starts on the leading "/" of the head row; the +2 columns undo the tail
    // row's stripped hanging indent so the end lands on the real ".ts" cell.
    expect(range.start).toEqual({ x: 1, y: 2 });
    expect(range.end).toEqual({ x: 7, y: 4 });
  });

  it("does NOT stitch hard wraps without cols (soft-wrap-only legacy path)", () => {
    expect(logicalLineAt(hardWrapped(), 2)).toEqual({
      startRow: 2,
      rows: ["  dd/ee/ff"],
      indents: [0],
    });
  });

  it("does NOT stitch a word wrap (upper row not full to cols)", () => {
    const buf = buffer([
      { text: "see /a/b" }, // trimmed length 8 < cols 10 — a natural break
      { text: "  /c/d.ts" },
    ]);
    expect(logicalLineAt(buf, 0, cols)).toEqual({
      startRow: 0,
      rows: ["see /a/b"],
      indents: [0],
    });
  });

  it("does NOT stitch when the next row resumes with a non-link glyph (a new tree item)", () => {
    const buf = buffer([
      { text: "/aa/bb/ccc" }, // full, ends mid-token
      { text: "  └ next.ts" }, // indented, but a tree glyph — not a continuation
    ]);
    expect(logicalLineAt(buf, 0, cols)).toEqual({
      startRow: 0,
      rows: ["/aa/bb/ccc"],
      indents: [0],
    });
  });
});
