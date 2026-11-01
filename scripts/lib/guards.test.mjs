import { describe, expect, it } from "vitest";
import { isRecord } from "./guards.mjs";

describe("isRecord", () => {
  it("takes a keyed object, a module namespace among them", async () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(await import("./guards.mjs"))).toBe(true);
  });

  it("refuses null, arrays, functions and primitives", () => {
    for (const value of [null, undefined, [], [{ a: 1 }], () => {}, "{}", 1, true]) {
      expect(isRecord(value), String(value)).toBe(false);
    }
  });
});
