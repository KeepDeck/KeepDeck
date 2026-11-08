import { describe, expect, it } from "vitest";
import type { UsageTimeline } from "../../domain/usage/daily";
import { OVERFLOW_COLOR } from "../usagePalette";
import { bucketTipView, bucketValue, usageChartTitle, usageChartView } from "./usageChartView";

const DAY = Date.parse("2026-07-20T00:00:00.000Z");
const COLORS = new Map([["claude", "#c1"]]);

const timeline = (over: Partial<UsageTimeline> = {}): UsageTimeline => ({
  granularity: "day",
  bucketMs: 86_400_000,
  buckets: [
    {
      start: DAY,
      byAgent: {
        claude: { totalTokens: 1_500, tokens: { cacheRead: 1_000, input: 400, output: 100 } },
        codex: { totalTokens: 7, tokens: {} },
      },
    },
    { start: DAY + 86_400_000, byAgent: {} },
  ],
  agents: ["claude", "codex"],
  ...over,
});

describe("usageChartTitle", () => {
  it("names the chart by the step of its buckets", () => {
    expect(usageChartTitle("hour")).toBe("Hourly tokens");
    expect(usageChartTitle("day")).toBe("Daily tokens");
  });
});

describe("usageChartView", () => {
  it("draws no chart for an empty period, or one whose buckets name no agent", () => {
    expect(usageChartView(timeline({ buckets: [] }), COLORS)).toBeNull();
    expect(usageChartView(timeline({ agents: [] }), COLORS)).toBeNull();
  });

  it("titles the chart, labels its axis, and colours each series like its card row", () => {
    const view = usageChartView(timeline(), COLORS);
    expect(view?.title).toBe("Daily tokens");
    expect(view?.tick(DAY)).toBe("Jul 20");
    expect(view?.color("claude")).toBe("#c1");
    expect(view?.color("codex")).toBe(OVERFLOW_COLOR);
  });
});

describe("bucketValue", () => {
  it("is an agent's tokens in the bucket, and zero for an agent absent from it", () => {
    const [first, second] = timeline().buckets;
    expect(first && bucketValue(first, "claude")).toBe(1_500);
    expect(second && bucketValue(second, "claude")).toBe(0);
  });
});

describe("bucketTipView", () => {
  it("shows nothing while nothing is hovered, or for a bucket with nothing in it", () => {
    expect(bucketTipView(timeline(), false, DAY, COLORS)).toBeNull();
    expect(bucketTipView(timeline(), true, DAY + 86_400_000, COLORS)).toBeNull();
    expect(bucketTipView(timeline(), true, 123, COLORS)).toBeNull();
  });

  it("names each agent of the bucket in roster order, with its total and what it was made of", () => {
    const tip = bucketTipView(timeline(), true, DAY, COLORS);
    expect(tip?.heading).toBe("Jul 20, 2026");
    expect(tip?.rows.map((row) => [row.agent, row.color, row.total, row.split])).toEqual([
      ["claude", "#c1", "1.5k", "cache 1k · ↑ 400 · ↓ 100"],
      ["codex", OVERFLOW_COLOR, "7", ""],
    ]);
    expect(tip?.rows[1]?.segments).toEqual([]);
  });
});
