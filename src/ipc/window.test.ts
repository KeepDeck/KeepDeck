import { describe, expect, it } from "vitest";
import { within } from "./window";

describe("within", () => {
  const origin = { x: 100, y: 50 };
  const size = { width: 800, height: 600 };

  it("holds a point inside the box, its near edges included", () => {
    expect(within({ x: 100, y: 50 }, origin, size)).toBe(true);
    expect(within({ x: 500, y: 300 }, origin, size)).toBe(true);
  });

  it("drops a point past any edge — the far edges are outside", () => {
    expect(within({ x: 99, y: 300 }, origin, size)).toBe(false);
    expect(within({ x: 900, y: 300 }, origin, size)).toBe(false);
    expect(within({ x: 500, y: 49 }, origin, size)).toBe(false);
    expect(within({ x: 500, y: 650 }, origin, size)).toBe(false);
  });
});
