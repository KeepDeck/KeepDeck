import { describe, expect, it } from "vitest";
import { queryUsageStats } from "./history/query";
import { recapCaption, usageRecap } from "./recap";

/** The production call shape: recap describes an already-aggregated period. */
const recapOf = (
  events: Parameters<typeof usageRecap>[0],
  period: Parameters<typeof usageRecap>[1],
  now: number,
) => usageRecap(events, period, now, queryUsageStats(events, period, now));

const DAY = 24 * 60 * 60 * 1_000;
import { TEST_NOW, usageEvent as event } from "./history/event.testSupport";

const NOW = TEST_NOW;


describe("usageRecap", () => {
  it("compares the period against the preceding equal-length period", () => {
    const recap = recapOf(      [
        event({ tokens: { input: 300 } }),
        event({ occurredAt: NOW - 8 * DAY, tokens: { input: 150 } }),
      ],
      7,
      NOW,
    );
    expect(recap.tokensDeltaPct).toBe(100);
  });

  it("never counts a boundary-instant event in both comparison windows", () => {
    const boundary = NOW - 7 * DAY;
    const recap = recapOf(      [
        event({ tokens: { input: 300 } }),
        event({ occurredAt: boundary, tokens: { input: 100 } }),
        event({ occurredAt: boundary - 1_000, tokens: { input: 100 } }),
      ],
      7,
      NOW,
    );
    // Boundary event belongs to the CURRENT window only: current = 400,
    // prior = 100 → +300%. Double-counting would have yielded +100%.
    expect(recap.tokensDeltaPct).toBe(300);
  });

  it("declines the delta without a predecessor: empty prior window or all-time", () => {
    const events = [event({ tokens: { input: 300 } })];
    expect(recapOf(events, 7, NOW).tokensDeltaPct).toBeNull();
    expect(
      recapOf(        [...events, event({ occurredAt: NOW - 8 * DAY })],
        "all",
        NOW,
      ).tokensDeltaPct,
    ).toBeNull();
  });

  it("crowns the model with the most tokens, not the most cost", () => {
    const recap = recapOf(      [
        event({
          model: "small-but-costed",
          tokens: { input: 100 },
          costSource: "provider",
          costUsd: 9,
        }),
        event({ model: "big-uncosted", tokens: { input: 900 } }),
      ],
      7,
      NOW,
    );
    expect(recap.topModel).toEqual({
      agent: "codex",
      model: "big-uncosted",
      totalTokens: 900,
    });
  });

  it("finds the heaviest UTC day inside the period only", () => {
    const recap = recapOf(      [
        event({ occurredAt: NOW - 1_000, tokens: { input: 100 } }),
        event({ occurredAt: NOW - 2 * DAY, tokens: { input: 400 } }),
        event({ occurredAt: NOW - 2 * DAY + 1, tokens: { input: 50 } }),
        event({ occurredAt: NOW - 20 * DAY, tokens: { input: 9_999 } }), // outside 7d
      ],
      7,
      NOW,
    );
    expect(recap.busiestDay).toEqual({
      dayStart: Date.parse("2026-07-20T00:00:00.000Z"),
      totalTokens: 450,
    });
  });

  it("never crowns the partial leading day, even when it leads in-window", () => {
    // Jul 15 is half-covered by the 7d window; its in-window slice out-earns
    // every full day but must not wear the crown with a sliced total.
    const recap = recapOf(
      [
        event({ occurredAt: NOW - 7 * DAY + 1_000, tokens: { input: 9_999 } }),
        event({ occurredAt: NOW - 2 * DAY, tokens: { input: 400 } }),
      ],
      7,
      NOW,
    );
    expect(recap.busiestDay).toEqual({
      dayStart: Date.parse("2026-07-20T00:00:00.000Z"),
      totalTokens: 400,
    });
  });

  it("is all-null on an empty period", () => {
    expect(recapOf([], 7, NOW)).toEqual({
      tokensDeltaPct: null,
      topModel: null,
      busiestDay: null,
    });
  });
});

describe("recapCaption", () => {
  it("phrases the sentence in the domain: order, separator, sign", () => {
    expect(
      recapCaption(
        {
          tokensDeltaPct: 12,
          topModel: { agent: "codex", model: "gpt-5.6-terra", totalTokens: 1_500_000 },
          busiestDay: {
            dayStart: Date.parse("2026-07-20T00:00:00.000Z"),
            totalTokens: 900_000,
          },
        },
        7,
      ),
    ).toBe(
      "+12% vs prior 7d · top model gpt-5.6-terra (1.5M) · busiest day Jul 20 (900k)",
    );
    expect(
      recapCaption(
        { tokensDeltaPct: -8, topModel: null, busiestDay: null },
        30,
      ),
    ).toBe("-8% vs prior 30d");
  });

  it("goes silent when the period offers no highlight", () => {
    expect(
      recapCaption({ tokensDeltaPct: null, topModel: null, busiestDay: null }, 7),
    ).toBe("");
  });
});
