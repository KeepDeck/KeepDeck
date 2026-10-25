import { describe, expect, it } from "vitest";
import { isJsonRecord, keysOf } from "./json";

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

describe("keysOf", () => {
  it("answers a table literal's own keys, in its order", () => {
    const TABLE = { b: 1, a: 2 } satisfies Record<"a" | "b", number>;
    const keys: ("a" | "b")[] = keysOf(TABLE);
    expect(keys).toEqual(["b", "a"]);
  });

  it("never reaches the prototype", () => {
    const table: Record<string, number> = Object.create({ inherited: 1 });
    table.own = 2;
    expect(keysOf(table)).toEqual(["own"]);
  });
});
