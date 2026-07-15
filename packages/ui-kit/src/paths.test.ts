import { describe, expect, it } from "vitest";
import { shortPath } from "./paths";

describe("shortPath", () => {
  it("keeps the last two segments of a deep path", () => {
    expect(shortPath("/Users/me/Projects/KeepDeck/test/kd-KeepDeck-6")).toBe(
      "test/kd-KeepDeck-6",
    );
  });

  it("returns a short path unchanged, without its leading slash", () => {
    expect(shortPath("/repo")).toBe("repo");
    expect(shortPath("/wt/a")).toBe("wt/a");
  });

  it("ignores trailing and repeated slashes", () => {
    expect(shortPath("/wt/a/")).toBe("wt/a");
    expect(shortPath("/wt//a")).toBe("wt/a");
  });

  it("degrades to empty for a path with no segments", () => {
    expect(shortPath("/")).toBe("");
    expect(shortPath("")).toBe("");
  });
});
