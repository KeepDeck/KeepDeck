import { describe, expect, it } from "vitest";
import {
  emberDraw,
  emberSpent,
  FALLBACK_GOLD,
  fieldRuns,
  fieldSize,
  glowStops,
  HALO,
  parseGold,
  reseed,
  seedField,
  type Ember,
} from "./embersField";

describe("the ember field", () => {
  const phases = (now: number, field: Ember[]) => new Set(field.map((spark) => now - spark.born));

  it("starts every ember at its own point in its own life", () => {
    const field = seedField(1_000);
    expect(field).toHaveLength(24);
    // A field born together flashes as one; a field mid-flight glows.
    expect(phases(1_000, field).size).toBeGreaterThan(20);
    expect([...phases(1_000, field)].every((age) => age >= 0)).toBe(true);
  });

  it("covers the card with exactly one ember per cell", () => {
    // Independent random points clump, and a clump reads as "all the sparks
    // are in one corner"; a shorter pool cycling through cells leaves a gap
    // that travels. One per cell is the only arrangement with neither.
    const cells = seedField(0).map((spark) => spark.cell);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it("puts a resumed field back mid-flight, not all at the starting line", () => {
    // The regression: a field parked behind the scroll came back with every
    // ember reborn on the same frame at phase zero, so the badge went dark,
    // bloomed at nearly twice its steady brightness, and troughed — and the
    // whole grid did it in step, since the observer reports newly visible
    // cards in one batch.
    const field = seedField(0);
    reseed(field, 5_000);
    expect(phases(5_000, field).size).toBeGreaterThan(20);
    // Same cells, so the coverage the grid buys is not lost on resume.
    expect(new Set(field.map((spark) => spark.cell)).size).toBe(field.length);
  });
});

describe("an ember's frame", () => {
  const spark: Ember = { cell: 0, fx: 0.5, fy: 0.5, dx: 10, dy: -4, radius: 2, peak: 0.8, born: 1_000, life: 2_000 };

  it("is spent once its life has run out, not before", () => {
    expect(emberSpent(spark, 3_000)).toBe(false);
    expect(emberSpent(spark, 3_001)).toBe(true);
  });

  it("drifts from where it lit and breathes dark–bright–dark", () => {
    const start = emberDraw(spark, 1_000, 200, 100);
    expect([start.x, start.y, start.alpha]).toEqual([100, 50, 0]);
    const middle = emberDraw(spark, 2_000, 200, 100);
    expect(middle.x).toBeCloseTo(105);
    expect(middle.y).toBeCloseTo(48);
    expect(middle.alpha).toBeCloseTo(0.8);
    expect(middle.halo).toBeCloseTo(2 * 2 * (0.7 + 0.45));
    expect(emberDraw(spark, 3_000, 200, 100).alpha).toBeCloseTo(0);
  });

  it("keeps the field inside the halo the canvas carries", () => {
    const corner: Ember = { ...spark, fx: 0, fy: 0, dx: 0, dy: 0 };
    expect(emberDraw(corner, 1_000, 200, 100)).toMatchObject({ x: HALO, y: HALO });
  });
});

describe("fieldSize", () => {
  it("takes a new box, rounded", () => {
    expect(fieldSize({ width: 120.4, height: 80.6 }, { width: 0, height: 0 })).toEqual({ width: 120, height: 81 });
  });

  it("changes nothing for the same box, or one too small for its halo", () => {
    expect(fieldSize({ width: 120, height: 80 }, { width: 120, height: 80 })).toBeNull();
    expect(fieldSize({ width: HALO * 2 - 1, height: 80 }, { width: 0, height: 0 })).toBeNull();
    expect(fieldSize({ width: 0, height: 0 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("fieldRuns", () => {
  it("holds still offscreen, or for a reader who asked for less motion", () => {
    expect(fieldRuns(false, false)).toBe(true);
    expect(fieldRuns(true, false)).toBe(false);
    expect(fieldRuns(false, true)).toBe(false);
  });
});

describe("the gold", () => {
  it("reads the stylesheet's colour as hex, short hex or rgb()", () => {
    expect(parseGold(" #e9ae48 ")).toEqual([233, 174, 72]);
    expect(parseGold("#fa0")).toEqual([255, 170, 0]);
    expect(parseGold("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
    expect(parseGold("rgba(10 20 30 / 0.5)")).toEqual([10, 20, 30]);
  });

  it("falls back to legendary's gold for anything it cannot read", () => {
    expect(parseGold("")).toEqual(FALLBACK_GOLD);
    expect(parseGold("var(--x)")).toEqual(FALLBACK_GOLD);
  });

  it("glows white-hot at the centre and gold to nothing at the edge", () => {
    expect(glowStops([200, 100, 0])).toEqual([
      [0, "rgba(255,255,255,1)"],
      [0.22, "rgba(243,221,199,0.95)"],
      [0.5, "rgba(200,100,0,0.45)"],
      [1, "rgba(200,100,0,0)"],
    ]);
  });
});
