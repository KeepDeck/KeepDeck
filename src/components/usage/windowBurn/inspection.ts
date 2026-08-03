import type { BurnGeometry, BurnPoint } from "../../../domain/usage/windowBurn";

export type BurnInspectionSample = BurnPoint & {
  kind: "observed" | "projected";
};

/** Resolve a horizontal plot position into the value shown by the UI.
 * History snaps to a report; only the forecast segment is interpolated. */
export function burnInspectionAt(
  geometry: BurnGeometry,
  xRatio: number,
): BurnInspectionSample {
  const x = Number.isFinite(xRatio) ? Math.min(1, Math.max(0, xRatio)) : 0;
  const projected = geometry.projected;
  if (projected !== null) {
    const [from, to] = projected;
    const span = to.x - from.x;
    if ((span > 0 && x > from.x) || (span === 0 && x >= from.x)) {
      const progress = span > 0 ? Math.min(1, (x - from.x) / span) : 1;
      const interpolate = (start: number, end: number) =>
        start + (end - start) * progress;
      return {
        kind: "projected",
        x: interpolate(from.x, to.x),
        y: interpolate(from.y, to.y),
        at: interpolate(from.at, to.at),
        usedPct: interpolate(from.usedPct, to.usedPct),
      };
    }
  }

  const nearest = geometry.observed.reduce((best, point) =>
    Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best,
  );
  return { ...nearest, kind: "observed" };
}
