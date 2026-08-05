import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatBucket, formatTokens, tokenBreakdown } from "../../domain/usage";
import {
  ledgerSeriesColors,
  seriesColorFor,
  CHART_AXIS,
  CHART_CURSOR_FILL,
  CHART_GRID,
  CHART_HEIGHT,
  CHART_LEGEND_INK,
  CHART_SURFACE,
  CHART_TICK_INK,
} from "../../domain/usage/chartPalette";
import {
  bucketShares,
  usageTimeline,
  type TimelineBucket,
  type UsageTimeline,
} from "../../domain/usage/daily";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import type { UsageStatsPeriod } from "../../domain/usage/history/query";

/**
 * Tokens over time, stacked by provider. Colors come from the domain's
 * roster-stable palette (see chartPalette.ts) — series AND chrome — keyed
 * on the FULL ledger roster so period switches never repaint a provider.
 * Buckets are rendered as-is; series read through accessor functions, so
 * an agent id can never collide with an axis field or be misread as a
 * lodash property path.
 */

type Granularity = UsageTimeline["granularity"];

/** Exhaustive by construction: a third granularity fails to compile until
 * it names its title and label rule. */
const TITLES: Record<Granularity, string> = {
  hour: "Hourly tokens",
  day: "Daily tokens",
};

export function UsageChart({
  events,
  period,
  now,
}: {
  events: readonly UsageEventV2[];
  period: UsageStatsPeriod;
  /** The dialog's shared wall clock — never a private Date.now(). */
  now: number;
}) {
  const timeline = useMemo(
    () => usageTimeline(events, period, now),
    [events, period, now],
  );
  const colors = useMemo(() => ledgerSeriesColors(events), [events]);
  // Nothing recorded, or recorded only in the leading sliver the full-bucket
  // axis excludes (agents lists the EMITTED buckets' roster) — an all-zero
  // plot with an empty legend reads as broken, not as quiet.
  if (timeline.buckets.length === 0 || timeline.agents.length === 0) return null;
  const title = TITLES[timeline.granularity];

  return (
    <section className="stats__section" aria-label={title}>
      <h3>{title}</h3>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart
          data={timeline.buckets as TimelineBucket[]}
          margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
          barCategoryGap="30%"
        >
          <CartesianGrid vertical={false} stroke={CHART_GRID} />
          <XAxis
            dataKey="start"
            tickFormatter={(value: number) =>
              formatBucket(value, timeline.granularity)
            }
            tick={{ fill: CHART_TICK_INK, fontSize: 10 }}
            axisLine={{ stroke: CHART_AXIS }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(value: number) => formatTokens(value)}
            tick={{ fill: CHART_TICK_INK, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <Tooltip
            cursor={{ fill: CHART_CURSOR_FILL }}
            isAnimationActive={false}
            content={(props) => (
              <BucketTip
                active={props.active === true}
                bucket={
                  (props.payload?.[0]?.payload as TimelineBucket | undefined) ??
                  null
                }
                agents={timeline.agents}
                colors={colors}
                granularity={timeline.granularity}
              />
            )}
          />
          <Legend
            iconSize={8}
            formatter={(value: string) => (
              <span style={{ color: CHART_LEGEND_INK, fontSize: 11 }}>
                {value}
              </span>
            )}
          />
          {timeline.agents.map((agent) => (
            <Bar
              key={agent}
              name={agent}
              dataKey={(bucket: TimelineBucket) =>
                bucket.byAgent[agent]?.totalTokens ?? 0
              }
              stackId="tokens"
              fill={colors.get(agent)}
              stroke={CHART_SURFACE}
              strokeWidth={1}
              maxBarSize={28}
              isAnimationActive={false}
            />
          ))}
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
 *
 * Providers keep the timeline's fixed alphabetical order rather than being
 * ranked by size, so the rows do not reshuffle as the cursor moves; a
 * provider absent from the bucket is omitted rather than shown as zero.
 */
function BucketTip({
  active,
  bucket,
  agents,
  colors,
  granularity,
}: {
  active: boolean;
  bucket: TimelineBucket | null;
  agents: readonly string[];
  colors: ReadonlyMap<string, string>;
  granularity: Granularity;
}) {
  if (!active || bucket === null) return null;
  const shares = bucketShares(bucket, agents);
  if (shares.length === 0) return null;
  return (
    <div className="stats__chart-tip">
      <b>{formatBucket(bucket.start, granularity, "long")}</b>
      {shares.map((share) => {
        const split = tokenBreakdown(share.tokens);
        return (
          <span className="stats__chart-tip-row" key={share.agent}>
            <span className="stats__chart-tip-name">
              {/* Identity is the square; the text stays ink, the rule the
                  old tooltip already followed. */}
              <i style={{ background: seriesColorFor(colors, share.agent) }} />
              {share.agent}
            </span>
            <span className="stats__chart-tip-total">
              {formatTokens(share.totalTokens)}
            </span>
            {split !== "" && (
              <span className="stats__chart-tip-split">{split}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
