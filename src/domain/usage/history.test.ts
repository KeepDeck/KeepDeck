import { describe, expect, it } from "vitest";
import {
  decodeUsageEvent,
  encodeUsageEvent,
  queryUsageStats,
  tokenTotal,
  usageDelta,
  usageDeltaEmpty,
  type UsageEventV1,
} from "./history";

describe("usageDelta", () => {
  it("turns cumulative token and cost snapshots into deltas", () => {
    const delta = usageDelta(
      { totalTokens: { input: 150, output: 20 }, costUsd: 1.5 },
      { tokens: { input: 100, output: 5 }, costUsd: 1 },
    );
    expect(delta).toEqual({
      tokens: { input: 50, output: 15 },
      reportedCostUsd: 0.5,
      hasReportedCost: true,
      observation: { tokens: { input: 150, output: 20 }, costUsd: 1.5 },
    });
  });

  it("treats a dropped counter as a reset and preserves absent baselines", () => {
    expect(
      usageDelta(
        { totalTokens: { input: 20 } },
        { tokens: { input: 100, output: 7 }, costUsd: 2 },
      ),
    ).toEqual({
      tokens: { input: 20 },
      hasReportedCost: false,
      observation: { tokens: { input: 20, output: 7 }, costUsd: 2 },
    });
  });

  it("recognizes duplicate cumulative observations", () => {
    const delta = usageDelta(
      { totalTokens: { input: 10 }, costUsd: 1 },
      { tokens: { input: 10 }, costUsd: 1 },
    );
    expect(usageDeltaEmpty(delta)).toBe(true);
  });
});

describe("queryUsageStats", () => {
  const base: UsageEventV1 = {
    schemaVersion: 1,
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
    costSource: "estimated",
    pricingVersion: "prices-v1",
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
          costSource: "reported",
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
      costUsd: 0.3,
      reportedCostUsd: 0.1,
      estimatedCostUsd: 0.2,
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

  it("tracks cost coverage instead of treating unavailable as zero", () => {
    const stats = queryUsageStats(
      [{ ...base, costUsd: undefined, costSource: "unavailable" }],
      90,
      2_000,
    );
    expect(stats.totals).toMatchObject({
      costUsd: 0,
      pricedEvents: 0,
      unpricedEvents: 1,
    });
  });
});

describe("usage event codec", () => {
  const event: UsageEventV1 = {
    schemaVersion: 1,
    eventId: "event-1",
    occurredAt: 10,
    capturedAt: 11,
    agent: "opencode",
    providerId: "anthropic",
    model: "claude-sonnet",
    workspaceId: "ws-1",
    workspaceName: "KeepDeck",
    workspaceCwd: "/repo",
    paneId: "pane-1",
    paneName: "Agent 1",
    sessionId: "ses-1",
    rootSessionId: "ses-1",
    tokens: { input: 10, output: 2 },
    costUsd: 0.1,
    costSource: "reported",
    observation: { tokens: { input: 50, output: 8 }, costUsd: 0.4 },
  };

  it("round-trips a valid line and rejects malformed or future lines", () => {
    expect(decodeUsageEvent(encodeUsageEvent(event))).toEqual(event);
    expect(decodeUsageEvent("{")).toBeNull();
    expect(decodeUsageEvent(JSON.stringify({ ...event, schemaVersion: 2 }))).toBeNull();
    expect(decodeUsageEvent(JSON.stringify({ ...event, tokens: { input: -1 } }))).toBeNull();
  });

  it("uses a source total when present and otherwise sums buckets", () => {
    expect(tokenTotal({ input: 10, output: 2, cacheRead: 4 })).toBe(16);
    expect(tokenTotal({ total: 99, input: 10 })).toBe(99);
  });
});
