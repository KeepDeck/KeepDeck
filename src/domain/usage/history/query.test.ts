import { describe, expect, it } from "vitest";
import type { UsageEventV2 } from "./event";
import { queryUsageStats } from "./query";

describe("queryUsageStats", () => {
  const base: UsageEventV2 = {
    schemaVersion: 2,
    eventId: "event-base",
    occurredAt: 1_000,
    capturedAt: 1_000,
    agent: "codex",
    model: "gpt-5.6-terra",
    workspaceId: "ws-1",
    workspaceName: "KeepDeck",
    workspaceCwd: "/repo",
    paneId: "pane-1",
    paneName: "Agent 1",
    sessionId: "session-1",
    rootSessionId: "session-1",
    tokens: { input: 100, output: 10 },
    costUsd: 0.2,
    costSource: "provider",
    observation: { tokens: { input: 100, output: 10 } },
  };

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
          costSource: "provider",
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
    expect(stats.sessionCount).toBe(1);
    expect(stats.totals).toMatchObject({
      tokens: { input: 150, output: 10, cacheRead: 20 },
      totalTokens: 180,
      providerCostUsd: 0.3,
      costEvents: 2,
    });
    expect(stats.byModel[0]).toMatchObject({
      agent: "codex",
      model: "gpt-5.6-terra",
      totalTokens: 180,
    });
    expect(stats.sessions[0]).toMatchObject({
      sessionId: "session-1",
      workspaceName: "KeepDeck",
      paneName: "Agent 1",
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

  it("does not treat unavailable provider cost as zero", () => {
    const stats = queryUsageStats(
      [{ ...base, costUsd: undefined, costSource: "unavailable" }],
      90,
      2_000,
    );
    expect(stats.totals).toMatchObject({
      providerCostUsd: 0,
      costEvents: 0,
    });
  });
});
