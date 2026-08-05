import { describe, expect, it } from "vitest";
import { TEST_NOW, windowReport as report } from "./reportJournal.testSupport";
import type { WindowReport } from "./reportJournal";
import type { UsageWindow } from "./usage";
import { windowBurn } from "./windowBurn";
import { windowForecast } from "./windowForecast";

/** The burn plot's own suite. It used to live inside `windowForecast.test.ts`
 * because the module had no file of its own — so the geometry's tests moved
 * only when someone remembered them. */

const NOW = TEST_NOW;
const MIN = 60_000;

/** A steady ramp: `pctPerMin` growth, newest report at `now`. */
const ramp = (
  pctPerMin: number,
  points: number,
  stepMin: number,
  lastPct: number,
  resetsAt: number | null = NOW + 155 * MIN,
): WindowReport[] =>
  Array.from({ length: points }, (_, index) => {
    const minutesAgo = (points - 1 - index) * stepMin;
    return report({
      reportedAt: NOW - minutesAgo * MIN,
      usedPct: lastPct - pctPerMin * minutesAgo,
      resetsAt,
    });
  });

const FIVE_H: UsageWindow = {
  usedPct: 62,
  resetsAt: NOW + 155 * MIN,
  windowMinutes: 300,
};

describe("windowBurn", () => {
  const doomedReports = ramp(0.29, 5, 10, 62);
  const out = windowForecast(doomedReports, FIVE_H, NOW);
  const okReports = ramp(0.1, 5, 10, 62);
  const ok = windowForecast(okReports, FIVE_H, NOW);

  it("fills the data axis and puts the out dot at the top-right corner", () => {
    const geometry = windowBurn(doomedReports, FIVE_H, out, NOW, "limit")!;
    // Data axis: first report at the left edge, projection end at the right.
    expect(geometry.observed[0].x).toBe(0);
    expect(geometry.out).toEqual({ x: 1, y: 1, level: "warn" });
    expect(geometry.endPct).toBeCloseTo(100, 5); // it reaches the ceiling
    const [from, to] = geometry.projected!;
    expect(from.y).toBeCloseTo(0.62, 2);
    expect(to.y).toBeCloseTo(1, 2);
  });

  it("caps a surviving pace at the reset: exits the right edge below the ceiling", () => {
    const geometry = windowBurn(okReports, FIVE_H, ok, NOW, "limit")!;
    expect(geometry.out).toBeNull();
    expect(geometry.projected![1].x).toBe(1);
    expect(geometry.projected![1].y).toBeLessThan(1);
    expect(geometry.endPct!).toBeGreaterThan(62);
    expect(geometry.endPct!).toBeLessThan(100);
  });

  it("charts a plan window on the same data axis — no reset anchor needed", () => {
    const plan: UsageWindow = { usedPct: 30, resetsAt: null, windowMinutes: null };
    const planReports = ramp(0.01, 5, 60, 30, null);
    const verdict = windowForecast(planReports, plan, NOW);
    const geometry = windowBurn(planReports, plan, verdict, NOW, "limit")!;
    expect(geometry.out).not.toBeNull(); // no reset will ever save it
    const expired: UsageWindow = { ...FIVE_H, resetsAt: NOW - 1 };
    expect(windowBurn(doomedReports, expired, out, NOW, "limit")).toBeNull();
  });

  it("draws observed-only up to now when the forecast is unknown", () => {
    const geometry = windowBurn(
      ramp(0.29, 2, 1, 62),
      FIVE_H,
      { kind: "unknown" },
      NOW,
      "limit",
    )!;
    expect(geometry.projected).toBeNull();
    expect(geometry.out).toBeNull();
    expect(geometry.observed[0].x).toBe(0);
    expect(geometry.observed[geometry.observed.length - 1].x).toBe(1);
  });
});

describe("the y scale is the surface's choice", () => {
  const quietReports = ramp(0, 5, 10, 10);
  const quietWindow: UsageWindow = {
    usedPct: 10,
    resetsAt: NOW + 155 * MIN,
    windowMinutes: 300,
  };
  const quiet = windowForecast(quietReports, quietWindow, NOW);

  it("draws the card against the whole limit, so a quiet window looks quiet", () => {
    // The card asks "how close am I to the wall" and has the height, the
    // ceiling label and the floor label to answer it. When the scale
    // followed the data instead, a window heading for 33% and one heading
    // for 100% climbed into the same corner at the same angle.
    const card = windowBurn(quietReports, quietWindow, quiet, NOW, "limit")!;
    expect(card.observed[0].y).toBeCloseTo(0.1, 3);
  });

  it("draws the popover against the data, so a 20px sparkline still reads", () => {
    // The compact plot is 20px tall with no ceiling and no floor label —
    // it asks "is this rising", and the percentage beside it carries the
    // level. On the limit scale this same window sat 1.6px above its own
    // axis line, inside the two strokes' combined width.
    const compact = windowBurn(quietReports, quietWindow, quiet, NOW, "data")!;
    expect(compact.observed[0].y).toBeGreaterThan(0.5);
  });

  it("still tops out at the limit on the data scale once the pace reaches it", () => {
    // "Data" is not "lie about the ceiling": a curve that genuinely reaches
    // 100 is drawn against 100 on either scale.
    const doomedReports = ramp(0.29, 5, 10, 62);
    const doomed = windowForecast(doomedReports, FIVE_H, NOW);
    const compact = windowBurn(doomedReports, FIVE_H, doomed, NOW, "data")!;
    expect(compact.out!.y).toBe(1);
  });
});
