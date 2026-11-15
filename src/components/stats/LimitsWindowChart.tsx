import { useId, useRef, type CSSProperties } from "react";
import type { BurnPoint } from "../../domain/usage/windowBurn";
import { burnAnnouncement } from "../../presentation/burnInspection";
import { limitsTooltipView, type LimitsChartView } from "../../presentation/stats/limitsChartView";
import { BurnTooltip } from "../usage/windowBurn/BurnTooltip";
import { InspectionStatus } from "../usage/windowBurn/InspectionStatus";
import { useBurnInspection } from "../usage/windowBurn/useBurnInspection";

/**
 * One window on its own clock (presentation/stats/limitsChartView.ts): the
 * provider's percent over it and where the pace takes it, named at the end
 * of the dashed line, and this machine's usage per day beneath. Drawn the
 * way the popover sparkline is: the SVG stretches horizontally only,
 * strokes keep their width, and everything that must not distort — dots and
 * every label — is HTML placed in percent. The pointer and the arrow keys
 * inspect it through the shared burn inspection; what the card says is
 * limitsTooltipView's. It draws what it is handed and decides nothing.
 */

const at = (share: number) => `${(share * 100).toFixed(2)}%`;
const fromTop = (pct: number) => at(1 - pct / 100);
const polyline = (points: readonly BurnPoint[]) =>
  points.map((point) => `${(point.x * 1000).toFixed(1)},${(100 - point.usedPct).toFixed(2)}`).join(" ");

export function LimitsWindowChart({ view, color }: { view: LimitsChartView; color: string }) {
  const { current } = view;
  const { geometry } = current;
  const last = geometry.observed[geometry.observed.length - 1];
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipId = `stats-limits-tooltip-${useId()}`;
  const { sample, getAnchorRect, handlers } = useBurnInspection(geometry, {
    ref: plotRef,
    depth: (point) => 1 - point.usedPct / 100,
  });
  const card = sample === null ? null : limitsTooltipView(view, sample);
  return (
    <figure className="stats__limits-chart" style={{ "--stats-series": color } as CSSProperties}>
      <div className="stats__limits-frame">
        <div className="stats__limits-edges" aria-hidden="true">
          <span>{view.start}</span>
          <span>{view.end}</span>
        </div>
        <div
          className="stats__limits-inspect"
          role="group"
          aria-label={view.summary}
          aria-describedby={sample ? tooltipId : undefined}
          tabIndex={0}
          {...handlers}
        >
          <div ref={plotRef} className="stats__limits-plot">
            <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
              {[0, 50, 100].map((level) => (
                <line key={level} className="stats__limits-level" x1={0} x2={1000} y1={100 - level} y2={100 - level} vectorEffect="non-scaling-stroke" />
              ))}
              {view.grid.map((x) => (
                <line key={x} className="stats__limits-day" x1={x * 1000} x2={x * 1000} y1={0} y2={100} vectorEffect="non-scaling-stroke" />
              ))}
              {geometry.projected && (
                <polyline className="stats__limits-projection" points={polyline(geometry.projected)} vectorEffect="non-scaling-stroke" />
              )}
              <polyline className="stats__limits-current" points={polyline(geometry.observed)} vectorEffect="non-scaling-stroke" />
              <line className="stats__limits-now" x1={view.now.x * 1000} x2={view.now.x * 1000} y1={0} y2={100} vectorEffect="non-scaling-stroke" />
            </svg>
            <span className="stats__limits-axis" style={{ top: "0%" }} aria-hidden="true">100%</span>
            <span className="stats__limits-axis" style={{ top: "50%" }} aria-hidden="true">50%</span>
            {last && <i className="stats__limits-dot" style={{ left: at(last.x), top: fromTop(last.usedPct) }} aria-hidden="true" />}
            {current.lone && (
              <span
                className={`stats__limits-lone stats__limits-lone--${current.lone.side}`}
                style={{ left: at(current.lone.x), top: fromTop(current.lone.pct) }}
                aria-hidden="true"
              >
                {current.lone.label}
              </span>
            )}
            {current.end && (
              <>
                <i
                  className={`stats__limits-end ${current.end.className ?? ""}`}
                  style={{ left: at(current.end.x), top: fromTop(current.end.pct) }}
                  aria-hidden="true"
                />
                <span
                  className={`stats__limits-end-label stats__limits-end-label--${current.end.side}${current.end.below ? " stats__limits-end-label--below" : ""} ${current.end.className ?? ""}`}
                  style={{ left: at(current.end.x), top: fromTop(current.end.pct) }}
                  aria-hidden="true"
                >
                  {current.end.label}
                </span>
              </>
            )}
            <span className={`stats__limits-now-label stats__limits-now-label--${view.now.side}`} style={{ left: at(view.now.x) }} aria-hidden="true">
              {view.now.label}
            </span>
            {sample && (
              <>
                <i className="stats__limits-cursor" style={{ left: at(sample.x) }} aria-hidden="true" />
                <i className="stats__limits-dot stats__limits-dot--active" style={{ left: at(sample.x), top: fromTop(sample.usedPct) }} aria-hidden="true" />
              </>
            )}
          </div>
          {view.bars.length > 0 && (
            <div className="stats__limits-bars" aria-hidden="true">
              {view.bars.map((bar) => (
                <i key={bar.key} title={bar.title} style={{ left: at(bar.x0), width: at(bar.x1 - bar.x0), height: at(bar.height) }} />
              ))}
            </div>
          )}
        </div>
        <div className="stats__limits-ticks" aria-hidden="true">
          {view.ticks.map((tick) => (
            <span key={tick.label + tick.x} style={{ left: at(tick.x) }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <InspectionStatus text={burnAnnouncement(card)} />
      {card && getAnchorRect && (
        <BurnTooltip
          id={tooltipId}
          getAnchorRect={getAnchorRect}
          view={card}
          stroke={color}
          ownerDocument={plotRef.current?.ownerDocument ?? document}
        />
      )}
    </figure>
  );
}
