import { useId, useRef } from "react";
import { OVERFLOW_COLOR } from "../../presentation/usagePalette";
import type { BurnGeometry } from "../../domain/usage/windowBurn";
import { momentTooltipView } from "../../presentation/burnInspection";
import type { TooltipAnchorRect } from "../../ui/tooltip/useAnchoredTooltipPosition";
import { BurnTooltip } from "./windowBurn/BurnTooltip";
import { useBurnInspection } from "./windowBurn/useBurnInspection";

/**
 * The popover's burn sparkline under a window's bar. The domain hands
 * data-axis geometry (see windowBurn.ts); this maps it onto a FIXED-height
 * plot: the SVG stretches horizontally only, strokes keep their width via
 * non-scaling-stroke, and the dots are HTML positioned in percent. Pointer
 * and keyboard inspection is the shared one (useBurnInspection), its words
 * presentation/burnInspection.ts.
 */

const HEIGHT = 20;
const PAD = 2;

/** Keep a dot's body inside the plot at the edges — a marker centered on
 * x=100% would hang half outside it. */
const dotLeft = (pct: number) =>
  `clamp(3px, ${pct.toFixed(2)}%, calc(100% - 3px))`;

export function WindowBurn({
  geometry,
  stroke = OVERFLOW_COLOR,
  now,
}: {
  /** Computed by the surface, which reads the same geometry. */
  geometry: BurnGeometry | null;
  /** Series color — supplied by the surface, which owns the roster the
   * palette contract requires (agentSeriesColors on a one-agent roster
   * breaks spare-slot ranking). */
  stroke?: string;
  /** The surface's clock — the hover card names instants relative to it. */
  now: number;
}) {
  // A single observation is not a curve — the chart earns its place with
  // the second report and never renders as an empty frame. Keeping interactive
  // state in the child also discards it when geometry temporarily disappears.
  if (geometry === null) return null;
  return <WindowBurnPlot geometry={geometry} stroke={stroke} now={now} />;
}

function WindowBurnPlot({ geometry, stroke, now }: { geometry: BurnGeometry; stroke: string; now: number }) {
  const plotRef = useRef<HTMLSpanElement | null>(null);
  const tooltipId = `usage-burn-tooltip-${useId()}`;
  const xPct = (value: number) => value * 100;
  const yPx = (value: number) => PAD + (1 - value) * (HEIGHT - 2 * PAD);
  const line = (points: readonly { x: number; y: number }[]) =>
    points.map((point) => `${xPct(point.x).toFixed(2)},${yPx(point.y).toFixed(2)}`).join(" ");
  const { sample, anchor, handlers } = useBurnInspection(geometry);

  const getAnchorRect =
    sample === null
      ? null
      : anchor !== null
        ? (): TooltipAnchorRect => ({ top: anchor.y, bottom: anchor.y, left: anchor.x })
        : (): TooltipAnchorRect | null => {
            const plot = plotRef.current;
            if (plot === null) return null;
            const rect = plot.getBoundingClientRect();
            const renderedHeight = rect.height || HEIGHT;
            const top = rect.top + (yPx(sample.y) / HEIGHT) * renderedHeight;
            return { top, bottom: top, left: rect.left + sample.x * rect.width };
          };

  return (
    <span className="usage-burn">
      <span
        ref={plotRef}
        className="usage-burn__plot"
        role="group"
        aria-label="Usage history and forecast"
        aria-describedby={sample ? tooltipId : undefined}
        tabIndex={0}
        {...handlers}
      >
        <svg aria-hidden viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none" style={{ height: HEIGHT }}>
          <line className="usage-burn__grid" x1="0" y1={yPx(1)} x2="100" y2={yPx(1)} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
          <line className="usage-burn__grid" x1="0" y1={yPx(0)} x2="100" y2={yPx(0)} vectorEffect="non-scaling-stroke" />
          <polyline fill="none" stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" points={line(geometry.observed)} />
          {geometry.projected && (
            <polyline
              fill="none"
              stroke={stroke}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              opacity={0.55}
              vectorEffect="non-scaling-stroke"
              points={line(geometry.projected)}
            />
          )}
        </svg>
        {geometry.out && (
          <i
            aria-hidden
            className={`usage-burn__dot usage-burn__dot--${geometry.out.level}`}
            style={{ left: dotLeft(xPct(geometry.out.x)), top: yPx(geometry.out.y) }}
          />
        )}
        {sample && (
          <>
            <i aria-hidden className="usage-burn__cursor" style={{ left: `${xPct(sample.x).toFixed(2)}%` }} />
            <i
              aria-hidden
              className="usage-burn__dot usage-burn__dot--active"
              style={{ left: dotLeft(xPct(sample.x)), top: yPx(sample.y), background: stroke }}
            />
          </>
        )}
      </span>
      {sample && getAnchorRect && (
        <BurnTooltip
          id={tooltipId}
          getAnchorRect={getAnchorRect}
          view={momentTooltipView(sample, now)}
          stroke={stroke}
          ownerDocument={plotRef.current?.ownerDocument ?? document}
        />
      )}
    </span>
  );
}
