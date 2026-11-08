import { describe, expect, it } from "vitest";
import type { UsageRow } from "./event";
import { queryUsageStats } from "./query";

describe("queryUsageStats", () => {
  const base: UsageRow = {
    eventId: "event-base",
    occurredAt: 1_000,
    capturedAt: 1_000,
    agent: "codex",
    model: "openai/gpt-5.6-terra",
    modelName: "GPT-5.6 Terra",
    workspaceId: "ws-1",
    workspaceName: "KeepDeck",
    workspaceCwd: "/repo",
    paneId: "pane-1",
    paneName: "Agent 1",
    sessionId: "session-1",
    rootSessionId: "session-1",
    tokens: { input: 100, output: 10 },
    costUsd: 0.2,
    costBasis: "estimated",
    count: 1,
    calls: 1,
  };

  it("has no first row in a period with none", () => {
    expect(queryUsageStats([base], 1, 10 * 24 * 60 * 60 * 1_000).firstOccurredAt).toBeNull();
  });

  it("filters the period and groups model and session deltas", () => {
    const stats = queryUsageStats(
      [
        base,
        {
          ...base,
          eventId: "event-2",
          occurredAt: 1_100,
          tokens: { input: 50, cacheRead: 20 },
          costUsd: 0.1,
          costBasis: "approximate",
        },
        {
          ...base,
          eventId: "expired",
          occurredAt: 0,
          tokens: { input: 9_999 },
        },
      ],
      1,
      24 * 60 * 60 * 1_000 + 1_000,
    );

    expect(stats.eventCount).toBe(2);
    expect(stats.firstOccurredAt).toBe(1_000);
    expect(stats.sessionCount).toBe(1);
    expect(stats.totals).toMatchObject({
      tokens: { input: 150, output: 10, cacheRead: 20 },
      totalTokens: 180,
      costUsd: 0.3,
      pricedEvents: 2,
      approximateEvents: 1,
      unpricedTokens: 0,
    });
    expect(stats.byModel[0]).toMatchObject({
      agent: "codex",
      model: "openai/gpt-5.6-terra",
      modelName: "GPT-5.6 Terra",
      totalTokens: 180,
    });
    expect(stats.sessions[0]).toMatchObject({
      sessionId: "session-1",
      workspaceName: "KeepDeck",
      paneName: "Agent 1",
      modelName: "GPT-5.6 Terra",
    });
  });

  it("spans the entire ledger for the all period", () => {
    const stats = queryUsageStats(
      [
        base,
        { ...base, eventId: "ancient", occurredAt: 0, tokens: { input: 9_999 } },
      ],
      "all",
      24 * 60 * 60 * 1_000 + 1_000,
    );
    expect(stats.period).toBe("all");
    expect(stats.eventCount).toBe(2);
    expect(stats.totals.totalTokens).toBe(110 + 9_999);
  });

  it("keeps an unpriced model's tokens out of the cost, and counts them as unpriced", () => {
    const stats = queryUsageStats(
      [{ ...base, costUsd: undefined, costBasis: "unpriced", tokens: { total: 40 } }],
      90,
      2_000,
    );
    expect(stats.totals).toMatchObject({
      costUsd: 0,
      pricedEvents: 0,
      unpricedTokens: 40,
    });
  });

  it("counts a compacted row by the events it stands for, not as one", () => {
    const bucket: UsageRow = {
      ...base,
      eventId: "bucket",
      count: 5,
      calls: 4,
      tokens: { input: 500 },
      costUsd: 0.9,
    };
    const stats = queryUsageStats([base, bucket], "all", 2_000);
    expect(stats.eventCount).toBe(6);
    expect(stats.totals.pricedEvents).toBe(6);
    expect(stats.totals.costUsd).toBeCloseTo(1.1);
  });
});
