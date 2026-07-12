import { describe, expect, it } from "vitest";
import {
  canHighlight,
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINE_CHARS,
} from "./limits";

describe("canHighlight", () => {
  it("accepts ordinary source text", () => {
    expect(canHighlight("const x = 1\nreturn x\n")).toBe(true);
    expect(canHighlight("")).toBe(true);
  });

  it("rejects text past the size cap, accepts text exactly at it", () => {
    const line = `${"x".repeat(63)}\n`; // 64 chars incl. newline
    const atCap = line.repeat(MAX_HIGHLIGHT_CHARS / 64);
    expect(atCap.length).toBe(MAX_HIGHLIGHT_CHARS);
    expect(canHighlight(atCap)).toBe(true);
    expect(canHighlight(atCap + "y")).toBe(false);
  });

  it("rejects a single over-long line anywhere in the text", () => {
    const minified = "x".repeat(MAX_HIGHLIGHT_LINE_CHARS + 1);
    expect(canHighlight(minified)).toBe(false);
    expect(canHighlight(`short\n${minified}\nshort`)).toBe(false);
    // Exactly at the line cap is fine.
    expect(canHighlight("x".repeat(MAX_HIGHLIGHT_LINE_CHARS))).toBe(true);
  });
});
