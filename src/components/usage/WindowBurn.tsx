import {
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { formatMoment, formatPct } from "../../domain/usage";
import {
  CHART_ITEM_INK,
  CHART_LABEL_INK,
  CHART_TOOLTIP_BG,
  CHART_TOOLTIP_BORDER,
  OVERFLOW_COLOR,
} from "../../domain/usage/chartPalette";
import type { BurnGeometry } from "../../domain/usage/windowBurn";
import type { BurnEdge } from "../../domain/usage/windowForecast";
import {
  useAnchoredTooltipPosition,
  type TooltipAnchorRect,
} from "../../ui/tooltip/useAnchoredTooltipPosition";
import {
  burnInspectionAt,
  type BurnInspectionSample,
} from "./windowBurn/inspection";

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

interface TooltipPoint {
  x: number;
  y: number;
}

interface PointerInspection {
  xRatio: number;
  anchor: TooltipPoint;
}

/** Keep a dot's body inside the plot at the edges — a marker centered on
 * x=100% would hang half outside its card. */
const dotLeft = (pct: number) =>
  `clamp(3px, ${pct.toFixed(2)}%, calc(100% - 3px))`;

export function WindowBurn({
  geometry,
  stroke = OVERFLOW_COLOR,
  edge = null,
  now,
  size = "card",
}: {
  /** Computed by the SURFACE, not here: the card's caption names where the
   * projection lands, so the chart and the sentence under it must read the
   * same geometry rather than each deriving its own. */
  geometry: BurnGeometry | null;
  /** Series color — supplied by the surface, which owns the roster the
   * palette contract requires (agentSeriesColors on a one-agent roster
   * breaks spare-slot ranking). */
  stroke?: string;
  /** What the right edge IS, as a moment (see `burnEdgeLabel`). */
  edge?: BurnEdge | null;
  /** The surface's clock — every instant this plot names is named relative
   * to it, so the hover card and the edge label cannot drift apart. */
  now: number;
  size?: keyof typeof PLOT_HEIGHTS;
}) {
  // A single observation is not a curve — the chart earns its place with
  // the second report and never renders as an empty frame. Keeping interactive
  // state in the child also discards it when geometry temporarily disappears.
  if (geometry === null) return null;

  return (
    <WindowBurnPlot
      geometry={geometry}
      stroke={stroke}
      edge={edge}
      now={now}
      size={size}
    />
  );
}

function WindowBurnPlot({
  geometry,
  stroke,
  edge,
  now,
  size,
}: {
  geometry: BurnGeometry;
  stroke: string;
  edge: BurnEdge | null;
  now: number;
  size: keyof typeof PLOT_HEIGHTS;
}) {
  const [pointer, setPointer] = useState<PointerInspection | null>(null);
  const [focused, setFocused] = useState(false);
  const plotRef = useRef<HTMLSpanElement | null>(null);
  const tooltipId = `usage-burn-tooltip-${useId()}`;
  const height = PLOT_HEIGHTS[size];
  const xPct = (value: number) => value * 100;
  const yPx = (value: number) => PAD + (1 - value) * (height - 2 * PAD);
  const line = (points: readonly { x: number; y: number }[]) =>
    points
      .map((point) => `${xPct(point.x).toFixed(2)},${yPx(point.y).toFixed(2)}`)
      .join(" ");
  const newest = geometry.observed[geometry.observed.length - 1];
  const focusSample: BurnInspectionSample | null = focused
    ? { ...newest, kind: "observed" }
    : null;
  const sample =
    pointer !== null ? burnInspectionAt(geometry, pointer.xRatio) : focusSample;

  const getAnchorRect =
    sample === null
      ? null
      : pointer !== null
        ? (): TooltipAnchorRect => ({
            top: pointer.anchor.y,
            bottom: pointer.anchor.y,
            left: pointer.anchor.x,
          })
        : (): TooltipAnchorRect | null => {
            const plot = plotRef.current;
            if (plot === null) return null;
            const rect = plot.getBoundingClientRect();
            const renderedHeight = rect.height || height;
            const top = rect.top + (yPx(sample.y) / height) * renderedHeight;
            return {
              top,
              bottom: top,
              left: rect.left + sample.x * rect.width,
            };
          };

  const inspectPointer = (event: ReactMouseEvent<HTMLSpanElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    setPointer({
      xRatio: (event.clientX - rect.left) / rect.width,
      anchor: { x: event.clientX, y: event.clientY },
    });
  };

  return (
    <span className={`usage-burn usage-burn--${size}`}>
      <span
        ref={plotRef}
        className="usage-burn__plot"
        role="group"
        aria-label="Usage history and forecast"
        aria-describedby={sample ? tooltipId : undefined}
        tabIndex={0}
        onMouseMove={inspectPointer}
        onMouseLeave={() => setPointer(null)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setPointer(null);
            setFocused(false);
          }
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
          {edge?.atReset === true && (
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
          // The frame's top IS the limit now, so this labels the ceiling
          // line rather than reporting a scale that moved with the data.
          <span className="usage-burn__ymax" aria-hidden>
            100%
          </span>
        )}
        {sample && (
          <>
            <i
              aria-hidden
              className="usage-burn__cursor"
              style={{ left: `${xPct(sample.x).toFixed(2)}%` }}
            />
            <i
              aria-hidden
              className="usage-burn__dot usage-burn__dot--active"
              style={{
                left: dotLeft(xPct(sample.x)),
                top: yPx(sample.y),
                background: stroke,
              }}
            />
          </>
        )}
      </span>
      {size === "card" && (
        <span className="usage-burn__foot" aria-hidden>
          <span>0</span>
          {/* The right edge is where the projection ends, and that instant
              is the whole question — named as a clock time rather than left
              to be derived from a countdown in another line. */}
          {edge !== null && (
            <span className={edge.level ? `usage-level--${edge.level}` : undefined}>
              {edge.text}
            </span>
          )}
        </span>
      )}
      {sample && getAnchorRect && (
        <BurnTooltip
          id={tooltipId}
          getAnchorRect={getAnchorRect}
          sample={sample}
          stroke={stroke}
          now={now}
          ownerDocument={plotRef.current?.ownerDocument ?? document}
        />
      )}
    </span>
  );
}

function BurnTooltip({
  id,
  getAnchorRect,
  sample,
  stroke,
  now,
  ownerDocument,
}: {
  id: string;
  getAnchorRect(): TooltipAnchorRect | null;
  sample: BurnInspectionSample;
  stroke: string;
  now: number;
  ownerDocument: Document;
}) {
  const { tooltipRef, position } = useAnchoredTooltipPosition({
    ownerDocument,
    getAnchorRect,
  });

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
      <span
        className="usage-burn-tooltip__label"
        style={{ color: CHART_LABEL_INK }}
      >
        {/* The SAME clock the edge label under this plot speaks. It used to
            go through the bucket formatter, which is UTC on purpose — but
            a report instant is not an aggregation boundary, and with a
            local label sitting two lines below, one widget was naming one
            moment in two timezones. */}
        {formatMoment(Math.round(sample.at), now)}
      </span>
      <span
        className="usage-burn-tooltip__value"
        style={{ color: CHART_ITEM_INK }}
      >
        <i aria-hidden style={{ background: stroke }} />
        <span>{sample.kind === "projected" ? "Projected" : "Observed"}</span>
        <b>{formatPct(sample.usedPct, "used")} used</b>
      </span>
    </div>,
    ownerDocument.body,
  );
}
