import { describe, expect, it } from "vitest";
import { emptyCostTally } from "../../domain/usage/history/event";
import type { UsageStats } from "../../domain/usage/history/query";
import type { UsageRecap } from "../../domain/usage/recap";
import { utcDayStart } from "../../domain/usage/time";
import { overviewView, recapCaption } from "./overviewView";

const NO_RECAP: UsageRecap = { tokensDeltaPct: null, topModel: null, busiestDay: null };

const stats = (over: Partial<UsageStats["totals"]> = {}, sessionCount = 2): UsageStats => ({
  period: 7,
  eventCount: 2,
  firstOccurredAt: 0,
  sessionCount,
  totals: { tokens: { input: 2_000, output: 200, cacheRead: 1_000 }, totalTokens: 3_200, ...emptyCostTally(), ...over },
  byModel: [],
  sessions: [],
});

describe("recapCaption", () => {
  it("phrases the sentence: order, separator, sign", () => {
    expect(
      recapCaption(
        {
          tokensDeltaPct: 12,
          topModel: { model: "gpt-5.6-terra", totalTokens: 1_500_000 },
          busiestDay: {
            // Through the bucket rule rather than a bare parse: the field is
            // branded, and minting one by hand is exactly what the brand is
            // there to stop.
            dayStart: utcDayStart(Date.parse("2026-07-20T00:00:00.000Z")),
            totalTokens: 900_000,
          },
        },
        7,
      ),
    ).toBe("+12% vs prior 7d · top model gpt-5.6-terra (1.5M) · busiest day Jul 20 (900k)");
    expect(recapCaption({ tokensDeltaPct: -8, topModel: null, busiestDay: null }, 30)).toBe("-8% vs prior 30d");
  });

  it("goes silent when the period offers no highlight", () => {
    expect(recapCaption(NO_RECAP, 7)).toBe("");
  });
});

describe("overviewView", () => {
  it("heads the tab with tokens and what they are made of, the cost, and the sessions", () => {
    const view = overviewView(stats({ costUsd: 0.5, pricedEvents: 2 }), NO_RECAP, 7);
    expect(view.cards).toEqual([
      { label: "Tokens", value: "3.2k", detail: "cache 1k · ↑ 2k · ↓ 200" },
      { label: "Cost", value: "≈$0.50", detail: null },
      { label: "Sessions", value: "2", detail: null },
    ]);
  });

  it("names no parts for tokens nobody broke down", () => {
    const view = overviewView({ ...stats(), totals: { ...stats().totals, tokens: {} } }, NO_RECAP, 7);
    expect(view.cards[0]?.detail).toBeNull();
  });

  it("shows the Highlights sentence only when the period has one", () => {
    expect(overviewView(stats(), NO_RECAP, 7).recap).toBeNull();
    expect(overviewView(stats(), { ...NO_RECAP, tokensDeltaPct: 5 }, 7).recap).toBe("+5% vs prior 7d");
  });

  it("says where the money comes from, and what shows when the chart cannot load", () => {
    const view = overviewView(stats(), NO_RECAP, 7);
    expect(view.coverage).toMatch(/^No model in this period has a known price/);
    expect(view.chartError).toBe("The chart could not be loaded.");
  });
});
