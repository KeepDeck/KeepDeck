import type { CSSProperties } from "react";
import type { ChartPoint, LimitsChartView } from "../../presentation/stats/limitsChartView";

/**
 * One window on its own clock (presentation/stats/limitsChartView.ts): the
 * provider's percent over it, the earlier windows under it, and this
 * machine's usage per day beneath. Drawn the way WindowBurn is: the SVG
 * stretches horizontally only, strokes keep their width, and everything
 * that must not distort — dots and every label — is HTML placed in
 * percent. It draws what it is handed and decides nothing.
 */

const at = (share: number) => `${(share * 100).toFixed(2)}%`;
const fromTop = (pct: number) => at(1 - pct / 100);
const polyline = (points: readonly ChartPoint[]) =>
  points.map((point) => `${(point.x * 1000).toFixed(1)},${(100 - point.pct).toFixed(2)}`).join(" ");

export function LimitsWindowChart({ view, color }: { view: LimitsChartView; color: string }) {
  const { current } = view;
  const last = current.points[current.points.length - 1];
  return (
    <figure className="stats__limits-chart" style={{ "--stats-series": color } as CSSProperties} aria-label={view.summary}>
      <figcaption className="stats__figure-label">{view.title}</figcaption>
      <div className="stats__limits-frame" aria-hidden="true">
        <div className="stats__limits-edges">
          <span>{view.start}</span>
          <span>{view.end}</span>
        </div>
        <div className="stats__limits-plot">
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
            {[0, 50, 100].map((level) => (
              <line key={level} className="stats__limits-level" x1={0} x2={1000} y1={100 - level} y2={100 - level} vectorEffect="non-scaling-stroke" />
            ))}
            {view.grid.map((x) => (
              <line key={x} className="stats__limits-day" x1={x * 1000} x2={x * 1000} y1={0} y2={100} vectorEffect="non-scaling-stroke" />
            ))}
            {view.slices.map((slice) => (
              <rect key={slice.key} className="stats__limits-slice" x={slice.x0 * 1000} width={(slice.x1 - slice.x0) * 1000} y={0} height={100} />
            ))}
            {view.earlier.map((earlier) => (
              <polyline
                key={earlier.key}
                className={`stats__limits-earlier${earlier.latest ? "" : " stats__limits-earlier--older"}`}
                points={polyline(earlier.points)}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {current.projection && (
              <polyline className="stats__limits-projection" points={polyline(current.projection)} vectorEffect="non-scaling-stroke" />
            )}
            <polyline className="stats__limits-current" points={polyline(current.points)} vectorEffect="non-scaling-stroke" />
            <line className="stats__limits-now" x1={view.now.x * 1000} x2={view.now.x * 1000} y1={0} y2={100} vectorEffect="non-scaling-stroke" />
          </svg>
          <span className="stats__limits-axis" style={{ top: "0%" }}>100%</span>
          <span className="stats__limits-axis" style={{ top: "50%" }}>50%</span>
          {view.slices.map((slice) => (
            <span
              key={slice.key}
              className={`stats__limits-note stats__limits-note--${slice.side}`}
              style={{ left: at(slice.side === "after" ? slice.x1 : slice.x0) }}
            >
              {slice.label}
            </span>
          ))}
          {view.earlier.map((earlier) =>
            earlier.end ? (
              <span
                key={earlier.key}
                className={`stats__limits-earlier-label stats__limits-earlier-label--${earlier.end.side}${earlier.end.below ? " stats__limits-earlier-label--below" : ""}`}
                style={{ left: at(earlier.end.x), top: fromTop(earlier.end.pct) }}
              >
                {earlier.label}
              </span>
            ) : null,
          )}
          {last && <i className="stats__limits-dot" style={{ left: at(last.x), top: fromTop(last.pct) }} />}
          {current.out && <i className={`stats__limits-out ${current.out.className ?? ""}`} style={{ left: at(current.out.x) }} />}
          <span className={`stats__limits-now-label stats__limits-now-label--${view.now.side}`} style={{ left: at(view.now.x) }}>
            {view.now.label}
          </span>
        </div>
        <div className="stats__limits-bars">
          {view.bars.map((bar) => (
            <i
              key={bar.key}
              className={bar.unpriced === "all" ? "stats__limits-bar--unpriced" : undefined}
              title={bar.title}
              style={{ left: at(bar.x0), width: at(bar.x1 - bar.x0), height: at(bar.height) }}
            />
          ))}
        </div>
        <div className="stats__limits-ticks">
          {view.ticks.map((tick) => (
            <span key={tick.label + tick.x} style={{ left: at(tick.x) }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}
