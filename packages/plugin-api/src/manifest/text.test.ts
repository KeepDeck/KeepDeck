import { describe, expect, it } from "vitest";
import { hasUnsafeText, stripUnsafeText } from "./text";

describe("unsafe-text guards", () => {
  it("flags controls, line separators and bidi; passes plain text", () => {
    expect(hasUnsafeText("plain — text · ok")).toBe(false);
    expect(hasUnsafeText("a\nb")).toBe(true);
    expect(hasUnsafeText("a\tb")).toBe(true);
    expect(hasUnsafeText("a b")).toBe(true);
    expect(hasUnsafeText("a‮b")).toBe(true); // RLO override
    expect(hasUnsafeText("a⁦b")).toBe(true); // isolate
    expect(hasUnsafeText("a‎b")).toBe(true); // LRM
  });

  it("is stateless across calls (no sticky lastIndex)", () => {
    // A shared `g`-flagged regex would alternate true/false here.
    expect(hasUnsafeText("a\nb")).toBe(true);
    expect(hasUnsafeText("a\nb")).toBe(true);
  });

  it("strips to a single trimmed visual line", () => {
    expect(stripUnsafeText("  a\n\nb‮  c  ")).toBe("a b c");
    expect(stripUnsafeText("  only")).toBe("only");
    expect(stripUnsafeText("\n‮\t")).toBe("");
  });
});
