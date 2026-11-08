import { formatBucket, formatTokens, tokenBreakdown, tokenSegments, type TokenSegment } from "../../domain/usage";
import { bucketShares, type TimelineBucket, type UsageTimeline } from "../../domain/usage/daily";
import { seriesColorFor } from "../usagePalette";

/**
 * The tokens-over-time chart, settled: whether there is a chart at all, its
 * title, each bar's value, and what the hover card says about a bucket. The
 * component wires these into the chart library and decides nothing.
 */

/** The chart's title, which is also its accessible name, by the step of its
 * buckets. Exhaustive by construction: a new granularity fails to compile
 * until it names its title. */
const TITLES: Record<UsageTimeline["granularity"], string> = {
  hour: "Hourly tokens",
  day: "Daily tokens",
};

export function usageChartTitle(granularity: UsageTimeline["granularity"]): string {
  return TITLES[granularity];
}

export interface UsageChartView {
  title: string;
  /** Mutable as the chart library types its data; never written. */
  buckets: TimelineBucket[];
  agents: readonly string[];
  /** A bucket's axis label. */
  tick(start: number): string;
  /** An agent's series colour — the same one its hover-card row wears. */
  color(agent: string): string;
}

/** The chart for a timeline, or none: nothing recorded, or recorded only in
 * the leading sliver the full-bucket axis excludes — an all-zero plot with
 * an empty legend reads as broken, not as quiet. */
export function usageChartView(
  timeline: UsageTimeline,
  colors: ReadonlyMap<string, string>,
): UsageChartView | null {
  if (timeline.buckets.length === 0 || timeline.agents.length === 0) return null;
  return {
    title: usageChartTitle(timeline.granularity),
    buckets: timeline.buckets,
    agents: timeline.agents,
    tick: (start) => formatBucket(start, timeline.granularity),
    color: (agent) => seriesColorFor(colors, agent),
  };
}

/** An agent's bar in a bucket: its tokens, or none for an agent absent from
 * the bucket. */
export function bucketValue(bucket: TimelineBucket, agent: string): number {
  return bucket.byAgent[agent]?.totalTokens ?? 0;
}

export interface BucketTipRowView {
  agent: string;
  color: string;
  total: string;
  /** What the tokens were made of, as a proportion; empty when the agent's
   * tokens have no breakdown. */
  segments: readonly TokenSegment[];
  split: string;
}

export interface BucketTipView {
  heading: string;
  rows: BucketTipRowView[];
}

/**
 * The hover card for the bucket starting at `start`: every agent that burned
 * tokens in it, each with what its tokens were MADE of. Agents keep the
 * timeline's fixed alphabetical order rather than being ranked by size, so
 * the rows do not reshuffle as the cursor moves; an agent absent from the
 * bucket is left out rather than shown as zero. None while nothing is
 * hovered, or the bucket holds nothing.
 */
export function bucketTipView(
  timeline: UsageTimeline,
  active: boolean,
  start: unknown,
  colors: ReadonlyMap<string, string>,
): BucketTipView | null {
  if (!active) return null;
  const bucket = timeline.buckets.find((candidate) => candidate.start === start);
  if (!bucket) return null;
  const shares = bucketShares(bucket, timeline.agents);
  if (shares.length === 0) return null;
  return {
    heading: formatBucket(bucket.start, timeline.granularity, "long"),
    rows: shares.map((share) => ({
      agent: share.agent,
      color: seriesColorFor(colors, share.agent),
      total: formatTokens(share.totalTokens),
      segments: tokenSegments(share.tokens),
      split: tokenBreakdown(share.tokens),
    })),
  };
}
