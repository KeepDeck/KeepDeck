import { currentSegment, type WindowReport } from "./reportJournal";
import type { WindowForecast } from "./windowForecast";
import { windowExpired, type UsageWindow } from "./usage";

/**
 * Burn-curve geometry on a DATA axis: x runs over what has actually been
 * seen — from the first journaled report of this window instance to `now`,
 * extended into the future when a projection exists. The curve therefore
 * always fills its frame from the second report on; a window-length axis
 * was live-verified to dwarf real history into a speck in an empty frame.
 *
 * The verdict stays geometric: a projection that reaches the ceiling puts
 * the out-dot at the top-right corner; one capped by the reset exits
 * through the right edge below the ceiling (`resetAtEdge`).
 */

export interface BurnPoint {
  x: number;
  y: number;
  /** Semantic values survive projection into plot coordinates so hover and
   * keyboard presentation never has to reverse-engineer domain data. */
  at: number;
  usedPct: number;
}

export interface BurnGeometry {
  observed: BurnPoint[];
  /** From the newest report to the projected end (the out instant, or the
   * reset when the pace survives it). Null without a usable pace. */
  projected: [BurnPoint, BurnPoint] | null;
  /** The ceiling-touch verdict dot; null when the pace survives the reset. */
  out: { x: number; y: number; level: "warn" | "critical" } | null;
  /** Where the pace leaves the window, in percent — the projection's end,
   * whether that is the ceiling or wherever the reset caught it. Null
   * without a usable pace. This is what a surviving window has to SAY: the
   * quiet case used to draw a curve and report nothing about it. */
  endPct: number | null;
  /** The right edge IS the reset (the projection was capped by it). */
  resetAtEdge: boolean;
}

/**
 * The y axis is ALWAYS the whole limit. It used to scale to the data —
 * 100 when the projection reached the ceiling, otherwise about 1.25× the
 * peak — which meant the curve filled its frame no matter how the window
 * ended. A window heading for 33% and one heading for 100% drew the same
 * climb into the same corner, so the shape carried no information and read
 * as alarm everywhere. The frame is the limit; how near the curve comes to
 * it is the entire point.
 *
 * The cost is real and correct: a window at 1% is a flat line along the
 * floor. Nothing IS happening there.
 */
const Y_MAX_PCT = 100;

const MAX_OBSERVED_POINTS = 300;

/** Even stride over the interior, always keeping the first and the last
 * report — endpoints anchor the axis and the projection. */
function sampleReports(segment: readonly WindowReport[]): readonly WindowReport[] {
  if (segment.length <= MAX_OBSERVED_POINTS) return segment;
  const stride = (segment.length - 1) / (MAX_OBSERVED_POINTS - 1);
  const sampled: WindowReport[] = [];
  for (let index = 0; index < MAX_OBSERVED_POINTS; index += 1) {
    sampled.push(segment[Math.round(index * stride)]);
  }
  return sampled;
}

export function windowBurn(
  reports: readonly WindowReport[],
  window: UsageWindow,
  forecast: WindowForecast,
  now: number,
): BurnGeometry | null {
  if (windowExpired(window, now)) return null;
  const segment = currentSegment(reports).filter(
    (report) => report.reportedAt <= now,
  );
  if (segment.length < 2) return null;
  const newest = segment[segment.length - 1];
  const tMin = segment[0].reportedAt;

  const outAt =
    (forecast.kind === "out" || forecast.kind === "ok") && forecast.outAt !== null
      ? forecast.outAt
      : null;
  // >= now, not > now: the "already at the wall" verdict clamps outAt to
  // now, and the strict comparison silently dropped the projection and the
  // verdict dot exactly when the forecast was most severe.
  const projEndAt =
    outAt !== null && outAt >= now
      ? window.resetsAt !== null
        ? Math.min(outAt, window.resetsAt)
        : outAt
      : null;
  const tEnd = projEndAt ?? now;
  if (tEnd <= tMin) return null;

  const drawn = sampleReports(segment);
  const projSpan = outAt !== null ? outAt - newest.reportedAt : 0;
  const projEndPct =
    projEndAt !== null && outAt !== null
      ? projSpan > 0
        ? newest.usedPct +
          (100 - newest.usedPct) *
            ((projEndAt - newest.reportedAt) / projSpan)
        : 100 // the wall is at (or before) the newest report
      : null;
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  const plotPoint = (at: number, pct: number) => ({
    x: clamp01((at - tMin) / (tEnd - tMin)),
    y: clamp01(pct / Y_MAX_PCT),
  });
  const point = (at: number, pct: number): BurnPoint => ({
    ...plotPoint(at, pct),
    at,
    usedPct: pct,
  });

  // A long-lived key can hold thousands of records; a 60px plot cannot use
  // more than a few hundred points, and the SVG string grows linearly.
  const observed = drawn.map((report) =>
    point(report.reportedAt, report.usedPct),
  );
  const projected: [BurnPoint, BurnPoint] | null =
    projEndAt !== null && projEndPct !== null
      ? [point(newest.reportedAt, newest.usedPct), point(projEndAt, projEndPct)]
      : null;
  const out =
    forecast.kind === "out" && projEndAt !== null
      ? {
          ...plotPoint(forecast.outAt, 100),
          level: forecast.level,
        }
      : null;
  const resetAtEdge =
    projEndAt !== null &&
    window.resetsAt !== null &&
    projEndAt === window.resetsAt;
  return {
    observed,
    projected,
    out,
    endPct: projEndPct,
    resetAtEdge,
  };
}
