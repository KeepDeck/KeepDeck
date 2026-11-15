import { formatMoment, formatPct } from "../domain/usage";
import type { BurnGeometry, BurnPoint } from "../domain/usage/windowBurn";

/**
 * Inspecting a burn plot — the popover sparkline and the Limits chart alike:
 * which point the reader is looking at, and what the hover card says about
 * it. The plots hold the pointer and key state; every decision is here.
 */

export type BurnInspectionSample = BurnPoint & {
  kind: "observed" | "projected";
};

/** What a plot is being inspected by: a pointer at a share of its width,
 * the arrow keys at one, or focus alone — which opens on the newest
 * reading. */
export interface BurnInspectionState {
  pointerX: number | null;
  keyedX: number | null;
  focused: boolean;
}

export const NO_INSPECTION: BurnInspectionState = { pointerX: null, keyedX: null, focused: false };

/** The point under inspection: the pointer's, else the keys', else — while
 * focused — the newest reading; none otherwise. */
export function inspectedSample(geometry: BurnGeometry, state: BurnInspectionState): BurnInspectionSample | null {
  const x = state.pointerX ?? state.keyedX;
  if (x !== null) return burnInspectionAt(geometry, x);
  const newest = geometry.observed[geometry.observed.length - 1];
  return state.focused && newest !== undefined ? { ...newest, kind: "observed" } : null;
}

/** How far one arrow press moves the inspected point, as a share of the plot. */
const KEY_STEP = 0.02;

/** Where an arrow press takes the inspection: one step along the plot from
 * the point inspected now (the newest reading when none is), kept inside it. */
export function steppedInspection(geometry: BurnGeometry, state: BurnInspectionState, direction: -1 | 1): number {
  const from = state.keyedX ?? inspectedSample(geometry, state)?.x ?? geometry.observed[geometry.observed.length - 1]?.x ?? 0;
  return Math.min(1, Math.max(0, from + direction * KEY_STEP));
}

/** The hover card's words. */
export interface BurnTooltipView {
  kind: "observed" | "projected";
  /** The instant, in the plot's own calendar. */
  label: string;
  /** "Observed" or "Projected". */
  source: string;
  value: string;
  /** One more fact about that instant, if the plot has one. */
  note: string | null;
}

export function burnTooltipView(sample: BurnInspectionSample, label: string, note: string | null = null): BurnTooltipView {
  return {
    kind: sample.kind,
    label,
    source: sample.kind === "projected" ? "Projected" : "Observed",
    value: `${formatPct(sample.usedPct, "used")} used`,
    note,
  };
}

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

/** The popover's hover card: the instant in the reader's clock — the same
 * local clock every label beside it speaks, never the UTC bucket formatter
 * (one widget once named one moment in two timezones). */
export function momentTooltipView(sample: BurnInspectionSample, now: number): BurnTooltipView {
  return burnTooltipView(sample, formatMoment(Math.round(sample.at), now));
}
