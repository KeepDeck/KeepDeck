import { describe, expect, it } from "vitest";
import { isJsonRecord, keyList } from "./json";

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

describe("keyList", () => {
  it("answers the listed keys, in the order written", () => {
    const TABLE = { b: 1, a: 2 } satisfies Record<"a" | "b", number>;
    const keys: readonly ("a" | "b")[] = keyList<typeof TABLE>()(["b", "a"]);
    expect(keys).toEqual(["b", "a"]);
  });

});
