import { describe, expect, it } from "vitest";
import { formatDroppedPaths } from "./droppedPaths";

describe("formatDroppedPaths", () => {
  it("wraps an image path (flagged) in a bracketed paste", () => {
    expect(formatDroppedPaths(["/Users/me/shot.png"], [true])).toBe(
      "\x1b[200~/Users/me/shot.png\x1b[201~",
    );
  });

  it("inserts a non-image path (file or folder) raw — no bracket, no quoting", () => {
    expect(formatDroppedPaths(["/Users/me/My Project"], [false])).toBe(
      "/Users/me/My Project",
    );
  });

  it("space-joins a mix: image bracketed, folder raw", () => {
    expect(formatDroppedPaths(["/a/img.jpg", "/b/dir"], [true, false])).toBe(
      "\x1b[200~/a/img.jpg\x1b[201~ /b/dir",
    );
  });

  it("returns an empty string for no paths", () => {
    expect(formatDroppedPaths([], [])).toBe("");
  });
});
