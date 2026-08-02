import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { formatBucket, formatPct, type UsageWindow } from "../../domain/usage";
import {
  CHART_ITEM_INK,
  CHART_LABEL_INK,
  CHART_TOOLTIP_BG,
  CHART_TOOLTIP_BORDER,
  OVERFLOW_COLOR,
} from "../../domain/usage/chartPalette";
import type { WindowReport } from "../../domain/usage/reportJournal";
import {
  burnHoverAt,
  windowBurn,
  type BurnHoverSample,
} from "../../domain/usage/windowBurn";
import type { WindowForecast } from "../../domain/usage/windowForecast";
import {
  calculateTooltipPosition,
  type TooltipPosition,
} from "../../ui/tooltipPlacement";

/**
 * The burn curve, shared by the Providers cards and the chip popover —
 * exactly like the fill bar is. The domain hands data-axis geometry (see
 * windowBurn.ts); this component maps it onto a FIXED-height plot: the
 * SVG stretches horizontally only (an aspect-locked SVG at width:100%
 * grew with the card and overflowed it — live finding), strokes keep
 * their width via non-scaling-stroke, and everything that must not
 * distort under horizontal stretch — the dots and the labels — is HTML
 * positioned in percent. The shared owner also provides pointer and keyboard
 * inspection, so both surfaces expose the same observed/projected semantics.
 */

const PLOT_HEIGHTS = { card: 60, compact: 20 } as const;
const PAD = 2;

interface TooltipAnchor {
  x: number;
  y: number;
}

interface BurnInspection {
  sample: BurnHoverSample;
  anchor: TooltipAnchor;
}

/** Keep a dot's body inside the plot at the edges — a marker centered on
 * x=100% would hang half outside its card. */
const dotLeft = (pct: number) => `clamp(3px, ${pct.toFixed(2)}%, calc(100% - 3px))`;

export function WindowBurn({
  stroke = OVERFLOW_COLOR,
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
  const geometry = useMemo(
    () => windowBurn(reports, window, forecast, now),
    [reports, window, forecast, now],
  );
  const [inspection, setInspection] = useState<BurnInspection | null>(null);
  const tooltipId = `usage-burn-tooltip-${useId()}`;
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

  const inspectPointer = (event: ReactMouseEvent<HTMLSpanElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    setInspection({
      sample: burnHoverAt(geometry, (event.clientX - rect.left) / rect.width),
      anchor: { x: event.clientX, y: event.clientY },
    });
  };

  const inspectFocus = (plot: HTMLSpanElement) => {
    const rect = plot.getBoundingClientRect();
    const renderedHeight = rect.height || height;
    setInspection({
      sample: { ...newest, kind: "observed" },
      anchor: {
        x: rect.left + newest.x * rect.width,
        y: rect.top + (yPx(newest.y) / height) * renderedHeight,
      },
    });
  };

  return (
    <span className={`usage-burn usage-burn--${size}`}>
      <span
        className="usage-burn__plot"
        role="group"
        aria-label="Usage history and forecast"
        aria-describedby={inspection ? tooltipId : undefined}
        tabIndex={0}
        onMouseMove={inspectPointer}
        onMouseLeave={() => setInspection(null)}
        onFocus={(event) => inspectFocus(event.currentTarget)}
        onBlur={() => setInspection(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setInspection(null);
        }}
      >
        {/* height set HERE, the one home PLOT_HEIGHTS — a CSS copy once
            drifted and the HTML dots (positioned in these units) slid off
            the line. */}
        <svg
          aria-hidden
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
            aria-hidden
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
            aria-hidden
            className={`usage-burn__dot usage-burn__dot--${geometry.out.level}`}
            style={{
              left: dotLeft(xPct(geometry.out.x)),
              top: yPx(geometry.out.y),
            }}
          />
        )}
        {size === "card" && (
          <span className="usage-burn__ymax" aria-hidden>
            {Math.round(geometry.yMaxPct)}%
          </span>
        )}
        {inspection && (
          <>
            <i
              aria-hidden
              className="usage-burn__cursor"
              style={{ left: `${xPct(inspection.sample.x).toFixed(2)}%` }}
            />
            <i
              aria-hidden
              className="usage-burn__dot usage-burn__dot--active"
              style={{
                left: dotLeft(xPct(inspection.sample.x)),
                top: yPx(inspection.sample.y),
                background: stroke,
              }}
            />
          </>
        )}
      </span>
      {size === "card" && (
        <span className="usage-burn__foot" aria-hidden>
          <span>0</span>
          {geometry.resetAtEdge && <span>reset</span>}
        </span>
      )}
      {inspection && (
        <BurnTooltip
          id={tooltipId}
          anchor={inspection.anchor}
          sample={inspection.sample}
          stroke={stroke}
          ownerDocument={document}
        />
      )}
    </span>
  );
}

function BurnTooltip({
  id,
  anchor,
  sample,
  stroke,
  ownerDocument,
}: {
  id: string;
  anchor: TooltipAnchor;
  sample: BurnHoverSample;
  stroke: string;
  ownerDocument: Document;
}) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const recompute = useCallback(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewport = ownerDocument.defaultView;
    const viewportWidth =
      ownerDocument.documentElement.clientWidth || viewport?.innerWidth || 0;
    const viewportHeight =
      ownerDocument.documentElement.clientHeight || viewport?.innerHeight || 0;
    setPosition(
      calculateTooltipPosition({
        anchorRect: {
          top: anchor.y,
          right: anchor.x,
          bottom: anchor.y,
          left: anchor.x,
        },
        tooltipWidth: tooltipRect.width,
        tooltipHeight: tooltipRect.height,
        viewportWidth,
        viewportHeight,
      }),
    );
  }, [anchor.x, anchor.y, ownerDocument, sample.at, sample.kind, sample.usedPct]);

  useLayoutEffect(() => {
    recompute();
    const viewport = ownerDocument.defaultView;
    viewport?.addEventListener("resize", recompute);
    return () => viewport?.removeEventListener("resize", recompute);
  }, [ownerDocument, recompute]);

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      className="usage-burn-tooltip"
      data-kind={sample.kind}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        maxHeight: position?.maxHeight,
        visibility: position ? "visible" : "hidden",
        background: CHART_TOOLTIP_BG,
        borderColor: CHART_TOOLTIP_BORDER,
      }}
    >
      <span className="usage-burn-tooltip__label" style={{ color: CHART_LABEL_INK }}>
        {formatBucket(Math.round(sample.at), "hour", "long")}
      </span>
      <span className="usage-burn-tooltip__value" style={{ color: CHART_ITEM_INK }}>
        <i aria-hidden style={{ background: stroke }} />
        <span>{sample.kind === "projected" ? "Projected" : "Observed"}</span>
        <b>{formatPct(sample.usedPct, "used")} used</b>
      </span>
    </div>,
    ownerDocument.body,
  );
}
