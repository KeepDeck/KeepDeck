import { describe, expect, it } from "vitest";
import { emptyCostTally } from "../../domain/usage/history/event";
import type { CostStep } from "../../domain/usage/stats/fold";
import { inZone } from "../../domain/usage/time.testSupport";
import { spendChartView, spendTipView, stepValue } from "./spendChartView";

const at = (iso: string) => new Date(iso).getTime();
const step = (start: number, byAgent: Record<string, number>, over: Partial<CostStep> = {}): CostStep => ({
  ...emptyCostTally(),
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
    const view = spendChartView(steps, "day", COLORS);
    expect(view?.agents).toEqual(["claude", "codex"]);
    expect(view?.color("claude")).toBe("#111111");
    expect(view?.color("codex")).toBe("#596273");
    expect(stepValue(steps[0] ?? step(0, {}), "codex")).toBe(1);
    expect(stepValue(steps[1] ?? step(0, {}), "codex")).toBe(0);
  });

  it("is absent only for a span with no steps", () => {
    expect(spendChartView([], "day", COLORS)).toBeNull();
    expect(spendChartView([step(0, {})], "day", COLORS)?.agents).toEqual([]);
  });

  it("labels its axis in local days or hours, and its values in dollars", () => {
    inZone("Asia/Nicosia", () => {
      expect(spendChartView(steps, "day", COLORS)?.tick(at("2026-11-08T00:00:00+02:00"))).toBe("Nov 8");
      expect(spendChartView(steps, "hour", COLORS)?.tick(at("2026-11-08T14:00:00+02:00"))).toBe("14:00");
      expect(spendChartView(steps, "day", COLORS)?.axis(1500)).toBe("$1,500");
    });
  });
});

describe("the spend chart's hover card", () => {
  it("lists the step's agents with their spend, and says what no price covers", () => {
    inZone("Asia/Nicosia", () => {
      const start = at("2026-11-08T00:00:00+02:00");
      const view = spendChartView([step(start, { claude: 2 }, { unpricedTokens: 14_280_000 })], "day", COLORS);
      if (view === null) throw new Error("no chart");
      expect(spendTipView(view, true, start)).toEqual({
        heading: "Sun, Nov 8, 2026",
        rows: [{ agent: "claude", color: "#111111", cost: "≈$2.00" }],
        unpriced: "14.3M tokens without a known price",
      });
    });
  });

  it("explains an unpriced-only step rather than showing nothing", () => {
    const view = spendChartView([step(5, {}, { unpricedTokens: 10, pricedEvents: 0 })], "day", COLORS);
    if (view === null) throw new Error("no chart");
    expect(spendTipView(view, true, 5)).toMatchObject({ rows: [], unpriced: "10 tokens without a known price" });
  });

  it("stays shut while nothing is hovered or the step is empty", () => {
    const view = spendChartView([step(5, {}, { pricedEvents: 0 })], "day", COLORS);
    if (view === null) throw new Error("no chart");
    expect(spendTipView(view, false, 5)).toBeNull();
    expect(spendTipView(view, true, 5)).toBeNull();
    expect(spendTipView(view, true, 6)).toBeNull();
  });
});
