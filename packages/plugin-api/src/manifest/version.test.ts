import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  MIN_COMPATIBLE_API_VERSION,
  isApiVersion,
  parseVersion,
  satisfiesApiFloor,
} from "./version.ts";

describe("parseVersion", () => {
  it("parses plain major.minor.patch", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("0.0.1")).toEqual([0, 0, 1]);
  });

  it("rejects anything that is not exactly three numeric parts", () => {
    for (const bad of ["1.2", "1.2.3.4", "v1.2.3", "1.2.x", "1.2.3-beta", ""]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });
});

describe("isApiVersion", () => {
  it("accepts a non-negative integer", () => {
    expect(isApiVersion(0)).toBe(true);
    expect(isApiVersion(7)).toBe(true);
  });

  it("rejects negatives, non-integers, and non-numbers", () => {
    for (const bad of [-1, 1.5, NaN, "7", "0.0.7", null, undefined]) {
      expect(isApiVersion(bad)).toBe(false);
    }
  });
});

describe("satisfiesApiFloor", () => {
  it("accepts a floor inside the host's compatibility window", () => {
    expect(satisfiesApiFloor(3, 3, 2)).toBe(true);
    expect(satisfiesApiFloor(2, 3, 2)).toBe(true);
    expect(satisfiesApiFloor(4, 3, 2)).toBe(false);
    expect(satisfiesApiFloor(1, 3, 2)).toBe(false);
  });

  it("fails closed on non-integer versions", () => {
    expect(satisfiesApiFloor(1.5, 3)).toBe(false);
    expect(satisfiesApiFloor(3, -1)).toBe(false);
    // A stray old-format string can never pass.
    expect(satisfiesApiFloor("0.0.1" as unknown as number, 3)).toBe(false);
  });

  it("defaults to the current API_VERSION", () => {
    expect(satisfiesApiFloor(API_VERSION)).toBe(true);
    expect(satisfiesApiFloor(MIN_COMPATIBLE_API_VERSION - 1)).toBe(false);
  });

  it("rejects pre-lifetime-ref plugins after the workspace API break", () => {
    expect(satisfiesApiFloor(20)).toBe(false);
    expect(API_VERSION).toBe(26);
    expect(MIN_COMPATIBLE_API_VERSION).toBe(21);
  });
});
