import { agentSeriesColors } from "../../domain/usage/chartPalette";
import type { UsageWindow } from "../../domain/usage";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { windowBurn } from "../../domain/usage/windowBurn";
import type { WindowForecast } from "../../domain/usage/windowForecast";

/**
 * The burn curve, shared by the Providers cards and the chip popover —
 * exactly like the fill bar is. The domain hands normalized geometry (x:
 * window start→reset, y: 0→100%); this component only maps it onto one of
 * two plots. The card plot is a full chart with axis labels; the popover
 * plot is a bare sparkline. BOTH render only once there is a projection to
 * draw: the curve exists to explain the verdict, and without a pace the
 * window-length axis dwarfs minutes of observations into a floating speck
 * inside an empty frame (live-verified). Decorative by contract
 * (aria-hidden): the caption carries the words.
 */

const SIZES = {
  card: { width: 340, height: 128, top: 8, bottom: 104, left: 26, right: 336 },
  compact: { width: 288, height: 24, top: 4, bottom: 20, left: 1, right: 287 },
} as const;

export function WindowBurn({
  agent,
  window,
  reports,
  forecast,
  now,
  size = "card",
}: {
  agent: string;
  window: UsageWindow;
  reports: readonly WindowReport[];
  forecast: WindowForecast;
  now: number;
  size?: keyof typeof SIZES;
}) {
  const geometry = windowBurn(reports, window, forecast, now);
  if (geometry === null || geometry.observed.length < 2) return null;
  if (geometry.projected === null) return null;
  const box = SIZES[size];
  const x = (value: number) => box.left + value * (box.right - box.left);
  const y = (value: number) => box.bottom - value * (box.bottom - box.top);
  const stroke = agentSeriesColors([agent]).get(agent);
  const strokeWidth = size === "card" ? 1.8 : 1.5;
  const line = (points: readonly { x: number; y: number }[]) =>
    points.map((point) => `${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`).join(" ");
  const newest = geometry.observed[geometry.observed.length - 1];

  return (
    <svg
      className={`usage-burn usage-burn--${size}`}
      viewBox={`0 0 ${box.width} ${box.height}`}
      aria-hidden
    >
      <line
        className="usage-burn__grid"
        x1={box.left}
        y1={y(1)}
        x2={box.right}
        y2={y(1)}
        strokeDasharray="2 3"
      />
      <line
        className="usage-burn__grid"
        x1={box.left}
        y1={y(0)}
        x2={box.right}
        y2={y(0)}
      />
      <line
        className="usage-burn__edge"
        x1={box.right}
        y1={box.top - 3}
        x2={box.right}
        y2={box.bottom + 3}
      />
      {size === "card" && (
        <g className="usage-burn__labels">
          <text x={box.left - 4} y={y(1) + 3} textAnchor="end">
            100%
          </text>
          <text x={box.left - 4} y={y(0) + 3} textAnchor="end">
            0
          </text>
          <text x={box.left} y={box.height - 6} textAnchor="start">
            start
          </text>
          <text x={box.right} y={box.height - 6} textAnchor="end">
            reset
          </text>
        </g>
      )}
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        points={line(geometry.observed)}
      />
      {geometry.projected && (
        <polyline
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray="5 4"
          opacity={0.55}
          points={line(geometry.projected)}
        />
      )}
      {size === "card" && (
        <circle
          cx={x(newest.x)}
          cy={y(newest.y)}
          r={2.6}
          fill={stroke}
          className="usage-burn__now"
        />
      )}
      {geometry.out && (
        <circle
          className={`usage-burn__out--${geometry.out.level}`}
          cx={x(geometry.out.x)}
          cy={y(geometry.out.y)}
          r={size === "card" ? 3 : 2.5}
        />
      )}
    </svg>
  );
}
