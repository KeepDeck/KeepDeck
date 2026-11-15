import { describe, expect, it } from "vitest";
import { TEST_NOW, windowReport as report } from "./reportJournal.testSupport";
import type { WindowReport } from "./reportJournal";
import type { UsageWindow } from "./usage";
import { windowBurn } from "./windowBurn";
import { windowForecast } from "./windowForecast";
import { present } from "@keepdeck/plugin-api/testing";

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
    const geometry = present(windowBurn(doomedReports, FIVE_H, out, NOW), "the doomed window's geometry");
    // Data axis: first report at the left edge, projection end at the right.
    expect(geometry.observed[0].x).toBe(0);
    expect(geometry.out).toEqual({ x: 1, y: 1, level: "warn" });
    const [from, to] = present(geometry.projected, "the projected line");
    expect(from.usedPct).toBeCloseTo(62, 2);
    // It reaches the ceiling, and the frame's top is the limit then.
    expect(to.usedPct).toBeCloseTo(100, 5);
    expect(to.y).toBeCloseTo(1, 2);
  });

  it("caps a surviving pace at the reset: exits the right edge below the ceiling", () => {
    const geometry = present(windowBurn(okReports, FIVE_H, ok, NOW), "the surviving window's geometry");
    expect(geometry.out).toBeNull();
    const projected = present(geometry.projected, "the projected line");
    expect(projected[1].x).toBe(1);
    expect(projected[1].y).toBeLessThan(1);
    expect(projected[1].usedPct).toBeGreaterThan(62);
    expect(projected[1].usedPct).toBeLessThan(100);
  });

  it("charts a plan window on the same data axis — no reset anchor needed", () => {
    const plan: UsageWindow = { usedPct: 30, resetsAt: null, windowMinutes: null };
    const planReports = ramp(0.01, 5, 60, 30, null);
    const verdict = windowForecast(planReports, plan, NOW);
    const geometry = present(windowBurn(planReports, plan, verdict, NOW), "the plan window's geometry");
    expect(geometry.out).not.toBeNull(); // no reset will ever save it
    const expired: UsageWindow = { ...FIVE_H, resetsAt: NOW - 1 };
    expect(windowBurn(doomedReports, expired, out, NOW)).toBeNull();
  });

  it("draws observed-only up to now when the forecast is unknown", () => {
    const geometry = present(
      windowBurn(ramp(0.29, 2, 1, 62), FIVE_H, { kind: "unknown" }, NOW),
      "the unknown-forecast geometry",
    );
    expect(geometry.projected).toBeNull();
    expect(geometry.out).toBeNull();
    expect(geometry.observed[0].x).toBe(0);
    expect(geometry.observed[geometry.observed.length - 1].x).toBe(1);
  });
});

describe("the y scale", () => {
  const quietReports = ramp(0, 5, 10, 10);
  const quietWindow: UsageWindow = {
    usedPct: 10,
    resetsAt: NOW + 155 * MIN,
    windowMinutes: 300,
  };
  const quiet = windowForecast(quietReports, quietWindow, NOW);

  it("follows the data, so a quiet window still reads in a 20px sparkline", () => {
    // On the limit scale this window sat 1.6px above its own axis line,
    // inside the two strokes' combined width.
    const geometry = present(windowBurn(quietReports, quietWindow, quiet, NOW), "the quiet geometry");
    expect(geometry.observed[0].y).toBeGreaterThan(0.5);
  });

  it("still tops out at the limit once the pace reaches it", () => {
    // Following the data is not lying about the ceiling.
    const doomedReports = ramp(0.29, 5, 10, 62);
    const doomed = windowForecast(doomedReports, FIVE_H, NOW);
    const geometry = present(windowBurn(doomedReports, FIVE_H, doomed, NOW), "the doomed geometry");
    expect(present(geometry.out, "the out dot").y).toBe(1);
  });
});
