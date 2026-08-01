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
import { formatTokens, formatUtcDay } from "../../domain/usage";
import { usageTimeline } from "../../domain/usage/daily";
import type { UsageEventV2, UsageStatsPeriod } from "../../domain/usage/history";

/**
 * Daily tokens, stacked by provider. Palette discipline: color follows the
 * ENTITY — each known agent owns a fixed categorical slot, so filters and
 * period switches never repaint a provider. The slots are the dataviz
 * default categorical order (dark steps), validated as a set against this
 * dialog's #0b0e14 card surface (all six checks pass; worst adjacent CVD
 * ΔE 8.4). Unknown future agents take the remaining slots in alphabetical
 * order; past eight the palette is exhausted and they fold into gray.
 */
const AGENT_SLOTS: Record<string, string> = {
  claude: "#3987e5",
  codex: "#d95926",
  kimi: "#199e70",
  opencode: "#c98500",
};
const SPARE_SLOTS = ["#d55181", "#008300", "#9085e9", "#e66767"];
const OVERFLOW_COLOR = "#596273";

/** The dialog card surface — bar strokes cut 2px visual gaps between
 * stacked segments and adjacent bars, per the mark spec. */
const SURFACE = "#0b0e14";

function seriesColors(agents: readonly string[]): Map<string, string> {
  const colors = new Map<string, string>();
  let spare = 0;
  for (const agent of agents) {
    const fixed = AGENT_SLOTS[agent];
    colors.set(
      agent,
      fixed ?? SPARE_SLOTS[spare++] ?? OVERFLOW_COLOR,
    );
  }
  return colors;
}

const HOUR_MS = 60 * 60 * 1_000;

/** Hour buckets are absolute instants, so their labels speak the user's
 * LOCAL clock — a "last 24h" axis in UTC hours would genuinely mislead.
 * Day buckets stay UTC-labeled to match their UTC boundaries. */
function bucketLabel(start: number, bucketMs: number, long = false): string {
  if (bucketMs !== HOUR_MS) return formatUtcDay(start, long);
  const time = new Date(start).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (!long) return time;
  const day = new Date(start).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `${day}, ${time}`;
}

export function UsageChart({
  events,
  period,
  now,
}: {
  events: readonly UsageEventV2[];
  period: UsageStatsPeriod;
  now: number;
}) {
  const timeline = usageTimeline(events, period, now);
  if (timeline.buckets.length === 0) return null;
  const rows = timeline.buckets.map((bucket) => ({
    day: bucket.start,
    ...bucket.byAgent,
  }));
  const colors = seriesColors(timeline.agents);
  const title = timeline.bucketMs === HOUR_MS ? "Hourly tokens" : "Daily tokens";

  return (
    <section className="stats__section stats__chart" aria-label={title}>
      <h3>{title}</h3>
      <ResponsiveContainer width="100%" height={190}>
        <BarChart
          data={rows}
          margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
          barCategoryGap="30%"
        >
          <CartesianGrid vertical={false} stroke="#171d28" />
          <XAxis
            dataKey="day"
            tickFormatter={(value: number) => bucketLabel(value, timeline.bucketMs)}
            tick={{ fill: "#596273", fontSize: 10 }}
            axisLine={{ stroke: "#1c2230" }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(value: number) => formatTokens(value)}
            tick={{ fill: "#596273", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <Tooltip
            cursor={{ fill: "rgba(255, 255, 255, 0.04)" }}
            contentStyle={{
              background: "#10141c",
              border: "1px solid #1c2230",
              borderRadius: 8,
              fontSize: 11,
              padding: "6px 10px",
            }}
            // Values and labels wear ink, never the series color — the
            // colored legend square beside each name carries identity.
            itemStyle={{ color: "#c5c8c6", padding: 0 }}
            labelStyle={{ color: "#596273", marginBottom: 4 }}
            formatter={(value) => formatTokens(Number(value))}
            labelFormatter={(value) =>
              bucketLabel(Number(value), timeline.bucketMs, true)
            }
          />
          <Legend
            iconSize={8}
            formatter={(value: string) => (
              <span style={{ color: "#9aa3af", fontSize: 11 }}>{value}</span>
            )}
          />
          {timeline.agents.map((agent) => (
            <Bar
              key={agent}
              dataKey={agent}
              stackId="tokens"
              fill={colors.get(agent)}
              stroke={SURFACE}
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
