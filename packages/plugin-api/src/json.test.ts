import { describe, expect, it } from "vitest";
import { isJsonRecord } from "./json";

describe("isJsonRecord", () => {
  it("accepts a plain object, empty or not", () => {
    expect(isJsonRecord({})).toBe(true);
    expect(isJsonRecord({ a: 1 })).toBe(true);
  });

  it("rejects null, arrays and primitives", () => {
    for (const value of [null, undefined, [], [1], "x", 1, true]) {
      expect(isJsonRecord(value)).toBe(false);
    }
  });
});
