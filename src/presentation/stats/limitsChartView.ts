import { formatMoment, formatPct, formatStep, formatTokens, windowLabel } from "../../domain/usage";
import { windowSteps, type ProviderWindowRow } from "../../domain/usage/providerWindows";
import { nextStep, stepStart } from "../../domain/usage/stats/fold";
import type { Span } from "../../domain/usage/stats/period";
import { currentSegment } from "../../domain/usage/reportJournal";
import { windowBurn, type BurnGeometry, type BurnPoint } from "../../domain/usage/windowBurn";
import { burnTooltipView, type BurnInspectionGeometry, type BurnInspectionSample, type BurnTooltipView } from "../burnInspection";
import { usageLevelClass } from "../usageView";

/**
 * The Limits card's chart, settled: one window on its own clock — x runs
 * from the window's start (0) to its reset (1) — with the provider's
 * percent over it and where the pace takes it, named at the end of the
 * dashed line, and this machine's usage per calendar day (per hour in a
 * short window) beneath. Every instant it shows is named on the reader's calendar: the
 * start, the reset, now, and each day — a curve without them said nothing
 * about when (user, 2026-11-15). Only the current window: the earlier ones
 * answered nothing the reader asked for.
 */

/** A point on the window's clock: `x` 0–1, `pct` the provider's percent. */
export interface ChartPoint {
  x: number;
  pct: number;
}

export interface LimitsChartView {
  /** The window's start and reset, named. */
  start: string;
  end: string;
  /** Its name goes after the line, or before it in the right part of the plot. */
  now: { x: number; label: string; side: "after" | "before" };
  /** Local midnights (or hours) inside the window. */
  grid: number[];
  /** A label per day (or hour) wide enough to carry one, at its middle. */
  ticks: { x: number; label: string }[];
  /** This window's readings and where the pace takes them, on the
   * window's clock (x 0–1, y the percent's share of the limit) — what the
   * lines are drawn from and what the pointer inspects. `end` is where the
   * dashed line stops, named: the limit and when it is reached, or what is
   * left at the reset — the forecast, said on the chart. */
  current: {
    geometry: BurnInspectionGeometry;
    end: (ChartPoint & { label: string; className?: string; side: "after" | "before"; below: boolean }) | null;
    /** Said beside the only reading the window has so far, so one dot does
     * not read as a line that failed to draw. */
    lone: (ChartPoint & { label: string; side: "after" | "before" }) | null;
  };
  /** This machine's tokens less cache reads per step, the busiest step full
   * height; `note` is what the hover card says of the step. None at all
   * while the machine used nothing in the window — no row of empty bars. */
  bars: { key: string; x0: number; x1: number; height: number; title: string; note: string }[];
  /** Read in place of the drawing. */
  summary: string;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Said of a window with a single report so far. */
const LONE = "1 report so far";

/** Null when the window has no span to lay a clock on. */
export function limitsChartView(
  main: ProviderWindowRow,
  now: number,
): LimitsChartView | null {
  const { span } = main;
  if (span === null) return null;
  const length = span.to - span.from;
  const x = (at: number) => clamp01((at - span.from) / length);
  const steps = windowSteps(span);
  const label = windowLabel(main.window, "long");
  const burn = windowBurn(main.reports, main.window, main.forecast, now);
  // At most one report in this window so far — counted, not inferred from a
  // chart that did not draw: two reports at one instant draw none either.
  const lone = currentSegment(main.reports).filter((report) => report.reportedAt <= now).length <= 1;
  const reading = (at: number, usedPct: number): BurnPoint => ({ x: x(at), y: usedPct / 100, at, usedPct });
  const usage = main.usage ?? [];
  const top = Math.max(0, ...usage.map((step) => step.tokensLessCacheReads));
  return {
    start: `started ${formatStep(span.from, "hour", "long")}`,
    end: `resets ${formatStep(span.to, "hour", "long")}`,
    now: { x: x(now), label: `now · ${formatStep(now, "hour", steps === "day" ? "long" : "short")}`, side: x(now) > 0.6 ? "before" : "after" },
    grid: cuts(span, steps).map(x),
    ticks: ticks(span, steps).map((tick) => ({ x: x(tick.at), label: tick.label })),
    current: {
      geometry: {
        // A lone reading is not a curve: it stands where it was read — the
        // account's report — not at now, when nothing arrived.
        observed: burn ? burn.observed.map((point) => reading(point.at, point.usedPct)) : [reading(main.reportedAt, main.window.usedPct)],
        projected: burn?.projected
          ? [reading(burn.projected[0].at, burn.projected[0].usedPct), reading(burn.projected[1].at, burn.projected[1].usedPct)]
          : null,
      },
      end: forecastEnd(main, burn, x, now),
      lone: lone ? { x: x(main.reportedAt), pct: main.window.usedPct, label: LONE, side: x(main.reportedAt) > 0.6 ? "before" : "after" } : null,
    },
    bars: top === 0 ? [] : usage.flatMap((step) => {
      const from = Math.max(step.start, span.from);
      const to = Math.min(nextStep(step.start, steps), span.to);
      if (to <= from) return [];
      const tokens = `${formatTokens(step.tokensLessCacheReads)} tokens`;
      return [{
        key: String(step.start),
        x0: x(from),
        x1: x(to),
        height: top > 0 ? step.tokensLessCacheReads / top : 0,
        title: `${formatStep(step.start, steps, "long")}: ${tokens}`,
        note: `This machine that ${steps}: ${tokens}`,
      }];
    }),
    summary: `${main.agent} ${label}: ${formatPct(main.window.usedPct, "used")} used, ${formatStep(span.from, "hour", "long")} to ${formatStep(span.to, "hour", "long")}${lone ? `; ${LONE}` : ""}`,
  };
}

/** Where the dashed line stops, named: the limit and when — in the warning's
 * colour — or the headroom left at the reset, in the verdict's own words. */
function forecastEnd(
  main: ProviderWindowRow,
  burn: BurnGeometry | null,
  x: (at: number) => number,
  now: number,
): LimitsChartView["current"]["end"] {
  const end = burn?.projected?.[1];
  const { forecast } = main;
  if (end === undefined || (forecast.kind !== "out" && forecast.kind !== "lasts")) return null;
  const point = { x: x(end.at), pct: end.usedPct };
  const place = { side: point.x > 0.6 ? ("before" as const) : ("after" as const), below: point.pct > 80 };
  if (forecast.kind === "lasts") return { ...point, ...place, label: `~${formatPct(forecast.endPct, "left")} at reset` };
  const className = usageLevelClass(forecast.level);
  return { ...point, ...place, label: `limit ~${formatMoment(forecast.outAt, now)}`, ...(className ? { className } : {}) };
}

/** The hover card at an inspected point of the chart: the instant with its
 * date — every instant on this chart is dated — whether it was reported or
 * projected and how full, and this machine's usage in the step under it,
 * while there is one (a projected day has none yet). */
export function limitsTooltipView(view: LimitsChartView, sample: BurnInspectionSample): BurnTooltipView {
  // Steps are half-open, but the reset is the last step's own end: a point
  // on the plot's right edge belongs to it.
  const bar = view.bars.find((step) => sample.x >= step.x0 && (sample.x < step.x1 || step.x1 === 1)) ?? null;
  return burnTooltipView(sample, formatStep(Math.round(sample.at), "hour", "long"), bar?.note ?? null);
}

/** The day (or hour) boundaries strictly inside the span. */
function cuts(span: Span, steps: "day" | "hour"): number[] {
  const out: number[] = [];
  for (let at = nextStep(stepStart(span.from, steps), steps); at < span.to; at = nextStep(at, steps)) out.push(at);
  return out;
}

/** At most this many names under a chart; a longer window names every
 * second (third…) day instead of none. */
const MAX_TICKS = 10;

/** A label per day (or hour), at the middle of its stretch inside the span —
 * a sliver of a day (a window that starts at 17:00) carries none, and a long
 * window names every n-th one so the names fit. */
function ticks(span: Span, steps: "day" | "hour"): { at: number; label: string }[] {
  const edges = [span.from, ...cuts(span, steps), span.to];
  const stretches = edges.slice(0, -1).map((from, index) => ({ from, to: edges[index + 1] ?? span.to }));
  // Half a day (half an hour) is room for a name; less is a sliver.
  const full = steps === "day" ? 12 * 60 * 60_000 : 30 * 60_000;
  const named = stretches.filter((stretch) => stretch.to - stretch.from >= full);
  const stride = Math.max(1, Math.ceil(named.length / MAX_TICKS));
  return named
    .filter((_, index) => index % stride === 0)
    .map((stretch) => ({ at: (stretch.from + stretch.to) / 2, label: formatStep(stepStart(stretch.from, steps), steps) }));
}
