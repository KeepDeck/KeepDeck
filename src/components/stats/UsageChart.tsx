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
import { formatBucket, formatTokens } from "../../domain/usage";
import {
  agentSeriesColors,
  CHART_AXIS,
  CHART_CURSOR_FILL,
  CHART_GRID,
  CHART_HEIGHT,
  CHART_ITEM_INK,
  CHART_LABEL_INK,
  CHART_LEGEND_INK,
  CHART_SURFACE,
  CHART_TICK_INK,
  CHART_TOOLTIP_BG,
  CHART_TOOLTIP_BORDER,
} from "../../domain/usage/chartPalette";
import {
  usageAgents,
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
  const colors = useMemo(() => agentSeriesColors(usageAgents(events)), [events]);
  if (timeline.buckets.length === 0) return null;
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
            contentStyle={{
              background: CHART_TOOLTIP_BG,
              border: `1px solid ${CHART_TOOLTIP_BORDER}`,
              borderRadius: 8,
              fontSize: 11,
              padding: "6px 10px",
            }}
            // Values and labels wear ink, never the series color — the
            // colored legend square beside each name carries identity.
            itemStyle={{ color: CHART_ITEM_INK, padding: 0 }}
            labelStyle={{ color: CHART_LABEL_INK, marginBottom: 4 }}
            formatter={(value) => formatTokens(Number(value))}
            labelFormatter={(value) =>
              formatBucket(Number(value), timeline.granularity, "long")
            }
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
              dataKey={(bucket: TimelineBucket) => bucket.byAgent[agent] ?? 0}
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
