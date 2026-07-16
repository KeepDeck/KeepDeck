import { describe, expect, it } from "vitest";
import { createTokenBucket } from "./tokenBucket";

describe("createTokenBucket", () => {
  it("grants the burst, then dries up", () => {
    const bucket = createTokenBucket(3, 10_000);
    expect([bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(bucket.take(0)).toBe(false);
  });

  it("refills one token per period, capped at the burst", () => {
    const bucket = createTokenBucket(3, 10_000);
    for (let i = 0; i < 3; i += 1) bucket.take(0);
    expect(bucket.take(9_999)).toBe(false); // just shy of a period
    expect(bucket.take(10_000)).toBe(true); // exactly one back
    expect(bucket.take(10_001)).toBe(false); // and only one
    // A long idle refills to the burst, never beyond it.
    expect(
      [1, 2, 3, 4].map(() => bucket.take(1_000_000)).filter(Boolean),
    ).toHaveLength(3);
  });

  it("a backward clock jump neither grants nor corrupts", () => {
    const bucket = createTokenBucket(1, 10_000);
    expect(bucket.take(50_000)).toBe(true);
    expect(bucket.take(10_000)).toBe(false); // jumped back: no refill
    expect(bucket.take(60_000)).toBe(true); // forward again: refilled
  });
});
