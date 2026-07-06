import { describe, expect, it } from "vitest";
import { API_VERSION, parseVersion, satisfiesApiFloor } from "./version.ts";

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

describe("satisfiesApiFloor", () => {
  it("accepts an equal floor", () => {
    expect(satisfiesApiFloor("1.2.3", "1.2.3")).toBe(true);
  });

  it("accepts a lower floor and rejects a higher one, per segment", () => {
    expect(satisfiesApiFloor("1.1.9", "1.2.0")).toBe(true);
    expect(satisfiesApiFloor("1.2.1", "1.2.0")).toBe(false);
    expect(satisfiesApiFloor("2.0.0", "1.9.9")).toBe(false);
    expect(satisfiesApiFloor("0.9.0", "1.0.0")).toBe(true);
  });

  it("fails closed on malformed versions", () => {
    expect(satisfiesApiFloor("not-a-version", "1.0.0")).toBe(false);
    expect(satisfiesApiFloor("1.0.0", "garbage")).toBe(false);
  });

  it("defaults to the current API_VERSION", () => {
    expect(satisfiesApiFloor(API_VERSION)).toBe(true);
  });
});
