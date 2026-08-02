import type { UsageWindow } from "../../domain/usage";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { windowBurn } from "../../domain/usage/windowBurn";
import type { WindowForecast } from "../../domain/usage/windowForecast";

/**
 * The burn curve, shared by the Providers cards and the chip popover —
 * exactly like the fill bar is. The domain hands data-axis geometry (see
 * windowBurn.ts); this component maps it onto a FIXED-height plot: the
 * SVG stretches horizontally only (an aspect-locked SVG at width:100%
 * grew with the card and overflowed it — live finding), strokes keep
 * their width via non-scaling-stroke, and everything that must not
 * distort under horizontal stretch — the dots and the labels — is HTML
 * positioned in percent. Decorative by contract (aria-hidden): the
 * caption beside it carries the words.
 */

const PLOT_HEIGHTS = { card: 60, compact: 20 } as const;
const PAD = 2;

/** Keep a dot's body inside the plot at the edges — a marker centered on
 * x=100% would hang half outside its card. */
const dotLeft = (pct: number) => `clamp(3px, ${pct.toFixed(2)}%, calc(100% - 3px))`;

export function WindowBurn({
  stroke = "#3d4863",
  window,
  reports,
  forecast,
  now,
  size = "card",
}: {
  /** Series color — supplied by the surface, which owns the roster the
   * palette contract requires (agentSeriesColors on a one-agent roster
   * breaks spare-slot ranking). */
  stroke?: string;
  window: UsageWindow;
  reports: readonly WindowReport[];
  forecast: WindowForecast;
  now: number;
  size?: keyof typeof PLOT_HEIGHTS;
}) {
  const geometry = windowBurn(reports, window, forecast, now);
  // A single observation is not a curve — the chart earns its place with
  // the second report and never renders as an empty frame.
  if (geometry === null) return null;
  const height = PLOT_HEIGHTS[size];
  const xPct = (value: number) => value * 100;
  const yPx = (value: number) => PAD + (1 - value) * (height - 2 * PAD);
  const line = (points: readonly { x: number; y: number }[]) =>
    points
      .map((point) => `${xPct(point.x).toFixed(2)},${yPx(point.y).toFixed(2)}`)
      .join(" ");
  const newest = geometry.observed[geometry.observed.length - 1];

  return (
    <span className={`usage-burn usage-burn--${size}`} aria-hidden>
      <span className="usage-burn__plot">
        {/* height set HERE, the one home PLOT_HEIGHTS — a CSS copy once
            drifted and the HTML dots (positioned in these units) slid off
            the line. */}
        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          style={{ height }}
        >
          <line
            className="usage-burn__grid"
            x1="0"
            y1={yPx(1)}
            x2="100"
            y2={yPx(1)}
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
          <line
            className="usage-burn__grid"
            x1="0"
            y1={yPx(0)}
            x2="100"
            y2={yPx(0)}
            vectorEffect="non-scaling-stroke"
          />
          {geometry.resetAtEdge && (
            <line
              className="usage-burn__edge"
              x1="100"
              y1="0"
              x2="100"
              y2={height}
              vectorEffect="non-scaling-stroke"
            />
          )}
          <polyline
            fill="none"
            stroke={stroke}
            strokeWidth={size === "card" ? 1.8 : 1.5}
            vectorEffect="non-scaling-stroke"
            points={line(geometry.observed)}
          />
          {geometry.projected && (
            <polyline
              fill="none"
              stroke={stroke}
              strokeWidth={size === "card" ? 1.8 : 1.5}
              strokeDasharray="5 4"
              opacity={0.55}
              vectorEffect="non-scaling-stroke"
              points={line(geometry.projected)}
            />
          )}
        </svg>
        {size === "card" && (
          <i
            className="usage-burn__dot"
            style={{
              left: dotLeft(xPct(newest.x)),
              top: yPx(newest.y),
              background: stroke,
            }}
          />
        )}
        {geometry.out && (
          <i
            className={`usage-burn__dot usage-burn__dot--${geometry.out.level}`}
            style={{
              left: dotLeft(xPct(geometry.out.x)),
              top: yPx(geometry.out.y),
            }}
          />
        )}
        {size === "card" && (
          <span className="usage-burn__ymax">
            {Math.round(geometry.yMaxPct)}%
          </span>
        )}
      </span>
      {size === "card" && (
        <span className="usage-burn__foot">
          <span>0</span>
          {geometry.resetAtEdge && <span>reset</span>}
        </span>
      )}
    </span>
  );
}
