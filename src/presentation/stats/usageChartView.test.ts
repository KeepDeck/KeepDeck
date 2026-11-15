import { describe, expect, it } from "vitest";
import { emptyUsageTally } from "../../domain/usage/stats/measure";
import type { UsageStep } from "../../domain/usage/stats/fold";
import { inZone } from "../../domain/usage/time.testSupport";
import { stepValue, usageChartView, usageTipView } from "./usageChartView";

const at = (iso: string) => new Date(iso).getTime();
const step = (start: number, byAgent: Record<string, number>, over: Partial<UsageStep> = {}): UsageStep => ({
  ...emptyUsageTally(),
  start,
  byAgent,
  costUsd: Object.values(byAgent).reduce((sum, v) => sum + v, 0),
  pricedEvents: Object.keys(byAgent).length,
  ...over,
});
const COLORS = new Map([["claude", "#111111"]]);

describe("the spend chart", () => {
  const steps = [
    step(at("2026-11-08T00:00:00+02:00"), { codex: 1, claude: 2 }),
    step(at("2026-11-09T00:00:00+02:00"), {}),
  ];

  it("stacks the agents with priced spend in a fixed alphabetical order", () => {
    const view = usageChartView(steps, "day", COLORS, "spend");
    expect(view.agents).toEqual(["claude", "codex"]);
    expect(view.color("claude")).toBe("#111111");
    expect(view.color("codex")).toBe("#596273");
    expect(stepValue(steps[0] ?? step(0, {}), "codex")).toBe(1);
    expect(stepValue(steps[1] ?? step(0, {}), "codex")).toBe(0);
  });

  it("draws any span — one with nothing priced has no agents to stack", () => {
    expect(usageChartView([], "day", COLORS, "spend")).toMatchObject({ steps: [], agents: [] });
    expect(usageChartView([step(0, {})], "day", COLORS, "spend").agents).toEqual([]);
  });

  it("labels its axis in local days or hours, and its values in dollars", () => {
    inZone("Asia/Nicosia", () => {
      expect(usageChartView(steps, "day", COLORS, "spend").tick(at("2026-11-08T00:00:00+02:00"))).toBe("Nov 8");
      expect(usageChartView(steps, "hour", COLORS, "spend").tick(at("2026-11-08T14:00:00+02:00"))).toBe("14:00");
      expect(usageChartView(steps, "day", COLORS, "spend").axis(1500)).toBe("$1,500");
    });
  });
});

describe("the chart's hover card", () => {
  it("lists the step's agents with their spend, and says what no price covers", () => {
    inZone("Asia/Nicosia", () => {
      const start = at("2026-11-08T00:00:00+02:00");
      const view = usageChartView([step(start, { claude: 2 }, { unpricedTokens: 14_280_000 })], "day", COLORS, "spend");
      expect(usageTipView(view, true, start)).toEqual({
        heading: "Sun, Nov 8, 2026",
        rows: [{ agent: "claude", color: "#111111", amount: "≈$2.00" }],
        unpriced: "14.3M tokens without a known price",
      });
    });
  });

  it("explains an unpriced-only step rather than showing nothing", () => {
    const view = usageChartView([step(5, {}, { unpricedTokens: 10, pricedEvents: 0 })], "day", COLORS, "spend");
    expect(usageTipView(view, true, 5)).toMatchObject({ rows: [], unpriced: "10 tokens without a known price" });
  });

  it("stays shut while nothing is hovered or the step is empty", () => {
    const view = usageChartView([step(5, {}, { pricedEvents: 0 })], "day", COLORS, "spend");
    expect(usageTipView(view, false, 5)).toBeNull();
    expect(usageTipView(view, true, 5)).toBeNull();
    expect(usageTipView(view, true, 6)).toBeNull();
  });
});

describe("the chart in tokens", () => {
  it("titles, labels and explains itself in tokens — no word of a price", () => {
    inZone("Asia/Nicosia", () => {
      const start = at("2026-11-08T00:00:00+02:00");
      const view = usageChartView([step(start, { claude: 1_500, kimi: 300 }, { unpricedTokens: 300 })], "day", COLORS, "tokens");
      expect([view.title, usageChartView([], "hour", COLORS, "tokens").title]).toEqual(["Tokens per day", "Tokens per hour"]);
      expect(view.axis(1_500_000)).toBe("1.5M");
      expect(usageTipView(view, true, start)).toEqual({
        heading: "Sun, Nov 8, 2026",
        rows: [
          { agent: "claude", color: "#111111", amount: "1.5k" },
          { agent: "kimi", color: "#596273", amount: "300" },
        ],
        unpriced: null,
      });
    });
  });
});
