import { describe, expect, it } from "vitest";
import { isHighlightReply, isHighlightRequest } from "./protocol";

describe("isHighlightRequest", () => {
  it("accepts a tokenize and a warm-up, the instance's included", () => {
    expect(isHighlightRequest({ kind: "tokenize", id: 3, text: "x", lang: "ts" })).toBe(true);
    expect(isHighlightRequest({ kind: "warm", lang: "cpp" })).toBe(true);
    expect(isHighlightRequest({ kind: "warm", lang: null })).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isHighlightRequest(null)).toBe(false);
    expect(isHighlightRequest({ kind: "tokenize", id: "3", text: "x", lang: "ts" })).toBe(false);
    expect(isHighlightRequest({ kind: "tokenize", id: 3, lang: "ts" })).toBe(false);
    expect(isHighlightRequest({ kind: "warm" })).toBe(false);
    expect(isHighlightRequest({ kind: "dispose" })).toBe(false);
  });
});

describe("isHighlightReply", () => {
  it("accepts lines, a null and an error", () => {
    expect(isHighlightReply({ id: 1, lines: [[], [{ text: "a", color: "#fff", italic: true }]] })).toBe(true);
    expect(isHighlightReply({ id: 1, lines: null })).toBe(true);
    expect(isHighlightReply({ id: 1, error: "boom" })).toBe(true);
  });

  it("refuses a reply whose runs are not runs", () => {
    expect(isHighlightReply({ id: 1, lines: [[{ text: 1 }]] })).toBe(false);
    expect(isHighlightReply({ id: 1, lines: [{ text: "a" }] })).toBe(false);
    expect(isHighlightReply({ id: 1, lines: [[{ text: "a", italic: "yes" }]] })).toBe(false);
    expect(isHighlightReply({ id: 1, error: 2 })).toBe(false);
    expect(isHighlightReply({ lines: null })).toBe(false);
  });
});
