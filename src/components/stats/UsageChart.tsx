import { useMemo } from "react";
import { Bar, BarChart, BarStack, Legend, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import {
  CHART_BAR_RADIUS,
  CHART_CURSOR_FILL,
  CHART_HEIGHT,
  CHART_LEGEND_INK,
  CHART_TEXT_SIZE,
  CHART_TICK_INK,
} from "../../domain/usage/chartPalette";
import { usageTimeline, type TimelineBucket } from "../../domain/usage/daily";
import type { UsageLedger } from "../../domain/usage/history/ledger";
import type { UsageStatsPeriod } from "../../domain/usage/history/query";
import {
  bucketTipView,
  bucketValue,
  usageChartView,
  type BucketTipView,
} from "../../presentation/stats/usageChartView";

/**
 * Tokens over time, stacked by provider — wide flush columns, the stack's
 * cap rounded, no grid and no value axis: the shape is the reading, and the
 * exact numbers live in the hover card. Colors come from the domain's
 * roster-stable palette — series (presentation/usagePalette.ts, keyed on
 * the agent catalog, so period switches never repaint a provider) and
 * chrome (chartPalette.ts). What the chart and its card say is settled in
 * presentation/stats/usageChartView.ts.
 * Buckets are rendered as-is; series read through accessor functions, so
 * an agent id can never collide with an axis field or be misread as a
 * lodash property path.
 */
export function UsageChart({
  ledger,
  colors,
  period,
  now,
}: {
  /** The ledger view — derived values are keyed on it, not on its array. */
  ledger: UsageLedger;
  /** The dialog's series colours (presentation/usagePalette.ts). */
  colors: ReadonlyMap<string, string>;
  period: UsageStatsPeriod;
  /** The dialog's shared wall clock — never a private Date.now(). */
  now: number;
}) {
  const timeline = useMemo(
    () => usageTimeline(ledger.events, period, now),
    [ledger, period, now],
  );
  const view = usageChartView(timeline, colors);
  if (!view) return null;

  return (
    <section className="stats__section stats__chart" aria-label={view.title}>
      <h3>{view.title}</h3>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart
          data={view.buckets}
          margin={{ top: 4, right: 0, left: 0, bottom: 0 }}
          barCategoryGap="12%"
        >
          <XAxis
            dataKey="start"
            tickFormatter={view.tick}
            tick={{ fill: CHART_TICK_INK, fontSize: CHART_TEXT_SIZE }}
            axisLine={false}
            tickLine={false}
            minTickGap={24}
          />
          <Tooltip
            cursor={{ fill: CHART_CURSOR_FILL }}
            isAnimationActive={false}
            /* recharts 3 portals the tooltip AND the legend into the same
               .recharts-wrapper, both absolute with no z-index — paint order
               follows DOM order, which follows JSX order. Legend sits below
               in this chart, so without this the legend paints over the
               hover card. */
            wrapperStyle={{ zIndex: 1 }}
            // The hovered bucket is found by the x value recharts reports —
            // its own payload row is untyped.
            content={(props) => (
              <BucketTip tip={bucketTipView(timeline, props.active === true, props.label, colors)} />
            )}
          />
          <Legend
            iconSize={8}
            formatter={(value: string) => (
              <span style={{ color: CHART_LEGEND_INK, fontSize: CHART_TEXT_SIZE }}>
                {value}
              </span>
            )}
          />
          {/* The stack is rounded as ONE column — its cap's corners, whatever
              segment happens to be on top, however thin: a per-segment
              radius left a sliver of a cap square on a square stack. */}
          <BarStack radius={[CHART_BAR_RADIUS, CHART_BAR_RADIUS, 0, 0]}>
            {view.agents.map((agent) => (
              <Bar
                key={agent}
                name={agent}
                dataKey={(bucket: TimelineBucket) => bucketValue(bucket, agent)}
                fill={view.color(agent)}
                isAnimationActive={false}
              />
            ))}
          </BarStack>
        </BarChart>
      </ResponsiveContainer>
    </section>
  );
}

/**
 * The hover card: every provider that burned tokens in this bucket, each
 * with what its tokens were MADE of.
 *
 * The bar can only ever say how much — its length is one number per
 * provider. The composition is the question the length raises and cannot
 * answer, and this is the only surface in the app where the two can be read
 * together, per provider, at a point in time.
 */
function BucketTip({ tip }: { tip: BucketTipView | null }) {
  if (!tip) return null;
  return (
    <div className="stats__chart-tip">
      <b>{tip.heading}</b>
      {tip.rows.map((row) => (
        <span className="stats__chart-tip-row" key={row.agent} style={{ "--series": row.color }}>
          <span className="stats__chart-tip-name">
            {/* Identity is the square; the text stays ink, the rule the
                old tooltip already followed. */}
            <i style={{ background: row.color }} />
            {row.agent}
          </span>
          <span className="stats__chart-tip-total">{row.total}</span>
          {row.segments.length > 0 && (
            <>
              {/* The split as a PROPORTION, not only as three numbers.
                  "cache 323.7M · ↑ 7.4k" is a sentence you have to do
                  arithmetic on; a bar that is almost entirely one shade
                  says "nearly all of this was cache" at a glance.
                  Shades of the provider's own colour, never three new
                  hues: in this card colour already means WHO, and a
                  second colour language inside it would fight the
                  square two lines up. */}
              <span className="stats__chart-tip-bar" aria-hidden>
                {row.segments.map((segment) => (
                  <i key={segment.kind} data-kind={segment.kind} style={{ flexGrow: segment.value }} />
                ))}
              </span>
              <span className="stats__chart-tip-split">{row.split}</span>
            </>
          )}
        </span>
      ))}
    </div>
  );
}
