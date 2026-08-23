import { describe, expect, it } from "vitest";
import {
  sanitizeHistoryFacts,
  sanitizeHistoryTranscriptPage,
} from "./hostSanitize";

/**
 * The shortfall's boundary rules. These matter more than they look: the seam
 * REBUILDS every answer from known fields, so a shortfall the rebuild forgets
 * is dropped in silence — and a silent drop here is invisible to the pins
 * that check the final shape, because a missing optional field compares equal
 * to one that was never sent. The tests below are what stands between "the
 * mark travelled" and "the mark was cut and nobody noticed".
 */
describe("shortfall across the boundary", () => {
  it("carries a well-formed shortfall through facts", () => {
    expect(
      sanitizeHistoryFacts({
        cwd: "/repo",
        shortfall: [{ kind: "bytes", size: 40_000_000, readBytes: 8_388_608 }],
      }),
    ).toEqual({
      cwd: "/repo",
      shortfall: [{ kind: "bytes", size: 40_000_000, readBytes: 8_388_608 }],
    });
  });

  it("carries two kinds at once — one read can fall short two ways", () => {
    const facts = sanitizeHistoryFacts({
      cwd: "/repo",
      shortfall: [
        { kind: "turns", total: 900, returned: 500 },
        { kind: "parts", unreadableParts: 3 },
      ],
    });
    expect(facts?.shortfall).toEqual([
      { kind: "turns", total: 900, returned: 500 },
      { kind: "parts", unreadableParts: 3 },
    ]);
  });

  it("leaves absence alone — no shortfall is not an empty shortfall", () => {
    const facts = sanitizeHistoryFacts({ cwd: "/repo" });
    expect(facts).toEqual({ cwd: "/repo" });
    expect(facts && "shortfall" in facts).toBe(false);
  });

  it("refuses an EMPTY array — it would be a second spelling of complete", () => {
    expect(sanitizeHistoryFacts({ cwd: "/repo", shortfall: [] })).toBeNull();
  });

  it("refuses an unknown kind rather than passing an unreadable measure", () => {
    expect(
      sanitizeHistoryFacts({
        cwd: "/repo",
        shortfall: [{ kind: "megabytes", size: 1, readBytes: 1 }],
      }),
    ).toBeNull();
  });

  it("refuses a measure that is not a finite number", () => {
    for (const bad of ["8388608", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(
        sanitizeHistoryFacts({
          cwd: "/repo",
          shortfall: [{ kind: "bytes", size: 40, readBytes: bad }],
        }),
      ).toBeNull();
    }
  });

  it("fails the WHOLE answer when one element is off-shape", () => {
    expect(
      sanitizeHistoryFacts({
        cwd: "/repo",
        shortfall: [
          { kind: "turns", total: 900, returned: 500 },
          { kind: "parts" },
        ],
      }),
    ).toBeNull();
  });

  it("a page carries its entries and its own shortfall", () => {
    expect(
      sanitizeHistoryTranscriptPage({
        entries: [{ role: "user", text: "hi" }],
        shortfall: [{ kind: "turns", total: 900, returned: 1 }],
      }),
    ).toEqual({
      entries: [{ role: "user", text: "hi" }],
      shortfall: [{ kind: "turns", total: 900, returned: 1 }],
    });
  });

  it("a page with junk entries fails whole, shortfall or not", () => {
    expect(
      sanitizeHistoryTranscriptPage({
        entries: [{ role: "narrator", text: "hi" }],
        shortfall: [{ kind: "parts", unreadableParts: 1 }],
      }),
    ).toBeNull();
  });

  it("refuses a `complete` flag smuggled alongside — completeness is DERIVED", () => {
    const page = sanitizeHistoryTranscriptPage({
      entries: [],
      complete: false,
    });
    expect(page).toEqual({ entries: [] });
    expect(page && "complete" in page).toBe(false);
  });
});
