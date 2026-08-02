import { agentSeriesColors } from "../../domain/usage/chartPalette";
import type { UsageWindow } from "../../domain/usage";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { windowBurn } from "../../domain/usage/windowBurn";
import type { WindowForecast } from "../../domain/usage/windowForecast";

/**
 * The burn curve, shared by the Providers cards and the chip popover —
 * exactly like the fill bar is. The domain hands normalized geometry (x:
 * window start→reset, y: 0→100%); this component only maps it onto one of
 * two plot sizes and draws. Decorative by contract (aria-hidden): the
 * caption beside it carries the words.
 */

const SIZES = {
  card: { width: 300, height: 56, top: 6, bottom: 50 },
  compact: { width: 288, height: 24, top: 4, bottom: 20 },
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
  // A single observation is not a curve — wait for history instead of
  // drawing a floating dot.
  if (geometry === null || geometry.observed.length < 2) return null;
  const box = SIZES[size];
  const x = (value: number) => 1 + value * (box.width - 2);
  const y = (value: number) => box.bottom - value * (box.bottom - box.top);
  const stroke = agentSeriesColors([agent]).get(agent);
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
        x1="1"
        y1={y(1)}
        x2={box.width - 1}
        y2={y(1)}
        strokeDasharray="2 3"
      />
      <line
        className="usage-burn__grid"
        x1="1"
        y1={y(0)}
        x2={box.width - 1}
        y2={y(0)}
      />
      <line
        className="usage-burn__edge"
        x1={box.width - 1}
        y1={box.top - 3}
        x2={box.width - 1}
        y2={box.bottom + 3}
      />
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={size === "card" ? 1.8 : 1.5}
        points={line(geometry.observed)}
      />
      {geometry.projected && (
        <polyline
          fill="none"
          stroke={stroke}
          strokeWidth={size === "card" ? 1.8 : 1.5}
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
