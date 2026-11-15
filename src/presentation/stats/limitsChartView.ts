import { formatLocalDay, formatPct, formatStep, windowLabel } from "../../domain/usage";
import { windowSteps, type ProviderWindowRow } from "../../domain/usage/providerWindows";
import { nextStep, stepStart } from "../../domain/usage/stats/fold";
import { amountOf, type StatsMeasure } from "../../domain/usage/stats/measure";
import type { Span } from "../../domain/usage/stats/period";
import { sampleReports, windowBurn } from "../../domain/usage/windowBurn";
import { usageLevelClass } from "../usageView";
import { displayAmount } from "./statsMeasures";

/**
 * The Limits card's chart, settled: one window on its own clock — x runs
 * from the window's start (0) to its reset (1) — with the provider's
 * percent over it and the earlier windows under it, the provider's shorter
 * windows marked where they run, and this machine's usage per calendar day
 * (per hour in a short window) beneath. Every instant it shows is named on
 * the reader's calendar: the start, the reset, now, and each day — a curve
 * without them said nothing about when (user, 2026-11-15).
 */

/** A reading on the window's clock: `x` 0–1, `pct` the provider's percent. */
export interface ChartPoint {
  x: number;
  pct: number;
}

export interface LimitsChartView {
  title: string;
  /** The window's start and reset, named. */
  start: string;
  end: string;
  now: { x: number; label: string };
  /** Local midnights (or hours) inside the window. */
  grid: number[];
  /** A label per day (or hour) wide enough to carry one, at its middle. */
  ticks: { x: number; label: string }[];
  /** This window's readings and where the pace takes them; the run-out
   * marked when it comes before the reset. */
  current: {
    points: ChartPoint[];
    projection: [ChartPoint, ChartPoint] | null;
    out: { x: number; className?: string } | null;
  };
  /** The earlier windows the journal holds, oldest first, each named by its
   * peak and its dates. */
  earlier: {
    key: string;
    label: string;
    points: ChartPoint[];
    latest: boolean;
    /** Where its name sits: at the end of its line — under it near the top
     * of the frame, where above would leave the plot. */
    end: (ChartPoint & { below: boolean }) | null;
  }[];
  /** The provider's shorter windows running now, where they sit. */
  slices: { key: string; x0: number; x1: number; label: string }[];
  /** This machine's usage per step, the busiest step full height. */
  bars: { key: string; x0: number; x1: number; height: number; title: string }[];
  /** Read in place of the drawing. */
  summary: string;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Null when the window has no span to lay a clock on. */
export function limitsChartView(
  main: ProviderWindowRow,
  others: readonly ProviderWindowRow[],
  now: number,
  measure: StatsMeasure,
): LimitsChartView | null {
  const { span } = main;
  if (span === null) return null;
  const length = span.to - span.from;
  const x = (at: number) => clamp01((at - span.from) / length);
  const steps = windowSteps(span);
  const label = windowLabel(main.window, "long");
  const burn = windowBurn(main.reports, main.window, main.forecast, now, "limit");
  const reading = (at: number, pct: number): ChartPoint => ({ x: x(at), pct });
  const usage = main.usage ?? [];
  const top = Math.max(0, ...usage.map((step) => amountOf(step, measure)));
  return {
    title: main.earlier.length > 0 ? "This window over the last ones" : "This window",
    start: `started ${formatStep(span.from, "hour", "long")}`,
    end: `resets ${formatStep(span.to, "hour", "long")}`,
    now: { x: x(now), label: `now · ${formatStep(now, "hour", steps === "day" ? "long" : "short")}` },
    grid: cuts(span, steps).map(x),
    ticks: ticks(span, steps).map((tick) => ({ x: x(tick.at), label: tick.label })),
    current: {
      // A single reading is not a curve: it is still where the window stands.
      points: burn ? burn.observed.map((point) => reading(point.at, point.usedPct)) : [reading(now, main.window.usedPct)],
      projection: burn?.projected
        ? [reading(burn.projected[0].at, burn.projected[0].usedPct), reading(burn.projected[1].at, burn.projected[1].usedPct)]
        : null,
      out: main.forecast.kind === "out" && burn?.out
        ? { x: x(main.forecast.outAt), ...(usageLevelClass(main.forecast.level) ? { className: usageLevelClass(main.forecast.level) } : {}) }
        : null,
    },
    earlier: main.earlier.map((window, index) => {
      const points = sampleReports(window.readings).map((report) => ({ x: clamp01((report.reportedAt - window.startsAt) / length), pct: report.usedPct }));
      const end = points[points.length - 1];
      return {
        key: String(window.resetsAt),
        label: `${formatPct(window.peakPct, "used")} · ${formatLocalDay(window.startsAt)} – ${formatLocalDay(window.resetsAt)}`,
        points,
        latest: index === main.earlier.length - 1,
        end: end === undefined ? null : { ...end, below: end.pct > 80 },
      };
    }),
    slices: others.flatMap((other) =>
      other.span === null || other.span.to - other.span.from >= length
        ? []
        : [{
            key: other.id,
            x0: x(other.span.from),
            x1: x(other.span.to),
            label: `${windowLabel(other.window, "long")} window · ${formatStep(other.span.from, "hour")}–${formatStep(other.span.to, "hour")}`,
          }],
    ),
    bars: usage.flatMap((step) => {
      const from = Math.max(step.start, span.from);
      const to = Math.min(nextStep(step.start, steps), span.to);
      if (to <= from) return [];
      const amount = amountOf(step, measure);
      return [{
        key: String(step.start),
        x0: x(from),
        x1: x(to),
        height: top > 0 ? amount / top : 0,
        title: `${formatStep(step.start, steps, "long")}: ${displayAmount(step, measure)}`,
      }];
    }),
    summary: `${main.agent} ${label}: ${formatPct(main.window.usedPct, "used")} used, ${formatStep(span.from, "hour", "long")} to ${formatStep(span.to, "hour", "long")}`,
  };
}

/** The day (or hour) boundaries strictly inside the span. */
function cuts(span: Span, steps: "day" | "hour"): number[] {
  const out: number[] = [];
  for (let at = nextStep(stepStart(span.from, steps), steps); at < span.to; at = nextStep(at, steps)) out.push(at);
  return out;
}

/** A label per day (or hour), at the middle of its stretch inside the span —
 * only where the stretch is wide enough to carry one: a window that starts
 * at 17:00 has a sliver of a first day, not a label crammed into it. */
function ticks(span: Span, steps: "day" | "hour"): { at: number; label: string }[] {
  const edges = [span.from, ...cuts(span, steps), span.to];
  const length = span.to - span.from;
  const room = steps === "day" ? 0.07 : 0.1;
  return edges.slice(0, -1).flatMap((from, index) => {
    const to = edges[index + 1] ?? span.to;
    if ((to - from) / length < room) return [];
    return [{ at: (from + to) / 2, label: formatStep(stepStart(from, steps), steps) }];
  });
}
