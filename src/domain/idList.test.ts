import { describe, expect, it } from "vitest";
import { sameIds } from "./idList";

describe("sameIds", () => {
  it("takes a reordering for the same ids", () => {
    expect(sameIds(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameIds([], [])).toBe(true);
  });

  it("tells a different id or a different length", () => {
    expect(sameIds(["a", "b"], ["a", "c"])).toBe(false);
    expect(sameIds(["a"], ["a", "b"])).toBe(false);
    expect(sameIds(["a", "b"], ["a"])).toBe(false);
  });
});
