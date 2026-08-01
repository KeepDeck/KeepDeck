import { describe, expect, it } from "vitest";
import type { UsageEventV2 } from "./history";
import { usageRecap } from "./recap";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse("2026-07-22T12:00:00.000Z");

let seq = 0;
const event = (over: Record<string, unknown> = {}): UsageEventV2 =>
  ({
    schemaVersion: 2,
    eventId: `event-${(seq += 1)}`,
    occurredAt: NOW - 1_000,
    capturedAt: NOW - 1_000,
    agent: "codex",
    model: "gpt-5.6-terra",
    workspaceId: "ws-1",
    workspaceName: "KeepDeck",
    workspaceCwd: "/repo",
    paneId: "pane-1",
    paneName: "Agent 1",
    sessionId: "s1",
    rootSessionId: "s1",
    tokens: { input: 100 },
    costSource: "unavailable",
    observation: { tokens: { input: 100 } },
    ...over,
  }) as UsageEventV2;

describe("usageRecap", () => {
  it("compares the period against the preceding equal-length period", () => {
    const recap = usageRecap(
      [
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
    const recap = usageRecap(
      [
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
    expect(usageRecap(events, 7, NOW).tokensDeltaPct).toBeNull();
    expect(
      usageRecap(
        [...events, event({ occurredAt: NOW - 8 * DAY })],
        "all",
        NOW,
      ).tokensDeltaPct,
    ).toBeNull();
  });

  it("crowns the model with the most tokens, not the most cost", () => {
    const recap = usageRecap(
      [
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
    const recap = usageRecap(
      [
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

  it("is all-null on an empty period", () => {
    expect(usageRecap([], 7, NOW)).toEqual({
      tokensDeltaPct: null,
      topModel: null,
      busiestDay: null,
    });
  });
});
