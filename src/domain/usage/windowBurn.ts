import { currentSegment, type WindowReport } from "./reportJournal";
import type { WindowForecast } from "./windowForecast";
import { windowExpired, type UsageWindow } from "./usage";

/**
 * Burn-curve geometry, normalized so the view only draws: x runs over the
 * window itself (0 = window start, 1 = reset), y over usage (0 = empty,
 * 1 = full). The verdict is then legible with no text at all — a line
 * hitting the ceiling before the right edge runs out early; one exiting
 * through the right edge below the ceiling makes it.
 */

export interface BurnPoint {
  x: number;
  y: number;
  /** The report instant behind the point (for hover captions). */
  at: number;
}

export interface BurnGeometry {
  observed: BurnPoint[];
  /** Two points — from the newest report to the projected end (the out
   * instant or the reset, whichever comes first). Null when the forecast
   * has no usable pace. */
  projected: [BurnPoint, BurnPoint] | null;
  /** The ceiling-touch verdict dot; null when the pace survives the reset. */
  out: { x: number; y: number; level: "warn" | "critical" } | null;
}

/** Null when the curve has no axis to stand on: an unknown-length or
 * unknown-reset window (no right edge), an expired window (the instant the
 * axis is anchored to is in the past), or an empty segment. */
export function windowBurn(
  reports: readonly WindowReport[],
  window: UsageWindow,
  forecast: WindowForecast,
  now: number,
): BurnGeometry | null {
  if (window.resetsAt === null || window.windowMinutes === null) return null;
  if (windowExpired(window, now)) return null;
  const end = window.resetsAt;
  const start = end - window.windowMinutes * 60_000;
  const spanMs = end - start;
  if (spanMs <= 0) return null;
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  const point = (at: number, pct: number): BurnPoint => ({
    x: clamp01((at - start) / spanMs),
    y: clamp01(pct / 100),
    at,
  });

  const segment = currentSegment(reports).filter(
    (report) => report.reportedAt <= now,
  );
  if (segment.length === 0) return null;
  const observed = segment.map((report) => point(report.reportedAt, report.usedPct));
  const newest = segment[segment.length - 1];

  const outAt =
    forecast.kind === "out" || forecast.kind === "ok" ? forecast.outAt : null;
  if (outAt === null) {
    return { observed, projected: null, out: null };
  }
  const projectedEndAt = Math.min(outAt, end);
  const endPct =
    newest.usedPct +
    (100 - newest.usedPct) *
      ((projectedEndAt - newest.reportedAt) / (outAt - newest.reportedAt || 1));
  const projected: [BurnPoint, BurnPoint] = [
    point(newest.reportedAt, newest.usedPct),
    point(projectedEndAt, endPct),
  ];
  const out =
    forecast.kind === "out"
      ? { x: clamp01((forecast.outAt - start) / spanMs), y: 1, level: forecast.level }
      : null;
  return { observed, projected, out };
}
