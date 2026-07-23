import { describe, expect, it } from "vitest";
import {
  decodeUsageEvent,
  encodeUsageEvent,
  queryUsageStats,
  tokenTotal,
  usageDelta,
  usageDeltaEmpty,
  type UsageEventV2,
} from "./history";

describe("usageDelta", () => {
  it("turns cumulative token and cost snapshots into deltas", () => {
    const delta = usageDelta(
      { totalTokens: { input: 150, output: 20 }, costUsd: 1.5 },
      { tokens: { input: 100, output: 5 }, costUsd: 1 },
    );
    expect(delta).toEqual({
      tokens: { input: 50, output: 15 },
      cost: { source: "provider", usd: 0.5 },
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
      cost: { source: "unavailable" },
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

  it("seeds a resumed session without backfilling lifetime usage", () => {
    expect(
      usageDelta(
        {
          totalTokens: { input: 100, output: 10 },
          costUsd: 9,
        },
        undefined,
        { baselineOnly: true },
      ),
    ).toEqual({
      tokens: {},
      cost: { source: "unavailable" },
      observation: { tokens: { input: 100, output: 10 }, costUsd: 9 },
    });
  });

  it("seeds independently arriving resumed cost and token dimensions", () => {
    const cost = usageDelta(
      { costUsd: 9 },
      undefined,
      { baselineOnly: true },
    );
    expect(cost).toEqual({
      tokens: {},
      cost: { source: "unavailable" },
      observation: { tokens: {}, costUsd: 9 },
    });

    const tokens = usageDelta(
      { totalTokens: { input: 100, output: 10 } },
      cost.observation,
      { baselineOnly: true },
    );
    expect(tokens).toEqual({
      tokens: {},
      cost: { source: "unavailable" },
      observation: {
        tokens: { input: 100, output: 10 },
        costUsd: 9,
      },
    });

    expect(
      usageDelta(
        { totalTokens: { input: 105, output: 12 }, costUsd: 9.5 },
        tokens.observation,
        { baselineOnly: true },
      ),
    ).toEqual({
      tokens: { input: 5, output: 2 },
      cost: { source: "provider", usd: 0.5 },
      observation: {
        tokens: { input: 105, output: 12 },
        costUsd: 9.5,
      },
    });
  });

  it("preserves an explicit initial provider cost of zero", () => {
    const delta = usageDelta({ costUsd: 0 });
    expect(delta).toEqual({
      tokens: {},
      cost: { source: "provider", usd: 0 },
      observation: { tokens: {}, costUsd: 0 },
    });
    expect(usageDeltaEmpty(delta)).toBe(false);
    expect(
      usageDeltaEmpty(
        usageDelta({ costUsd: 0 }, { tokens: {}, costUsd: 0 }),
      ),
    ).toBe(true);
  });
});

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

describe("usage event codec", () => {
  const event: UsageEventV2 = {
    schemaVersion: 2,
    eventId: "event-1",
    occurredAt: 10,
    capturedAt: 11,
    agent: "opencode",
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
    costSource: "provider",
    observation: { tokens: { input: 50, output: 8 }, costUsd: 0.4 },
  };

  it("round-trips a valid line and rejects malformed or future lines", () => {
    expect(decodeUsageEvent(encodeUsageEvent(event))).toEqual(event);
    expect(decodeUsageEvent("{")).toBeNull();
    expect(decodeUsageEvent(JSON.stringify({ ...event, schemaVersion: 3 }))).toBeNull();
    expect(decodeUsageEvent(JSON.stringify({ ...event, tokens: { input: -1 } }))).toBeNull();
    expect(
      decodeUsageEvent(
        JSON.stringify({ ...event, costSource: "provider", costUsd: undefined }),
      ),
    ).toBeNull();
    expect(
      decodeUsageEvent(
        JSON.stringify({ ...event, costSource: "unavailable", costUsd: 0.1 }),
      ),
    ).toBeNull();
  });

  it("migrates v1 without retaining local estimates or bad Claude tokens", () => {
    const v1 = { ...event, schemaVersion: 1 };
    expect(
      decodeUsageEvent(
        JSON.stringify({
          ...v1,
          costSource: "reported",
          costUsd: 0.1,
          pricingVersion: undefined,
        }),
      ),
    ).toMatchObject({
      schemaVersion: 2,
      tokens: { input: 10, output: 2 },
      costSource: "provider",
      costUsd: 0.1,
    });
    const estimated = decodeUsageEvent(
      JSON.stringify({
        ...v1,
        costSource: "estimated",
        pricingVersion: "old-local-table",
      }),
    );
    expect(estimated).toMatchObject({
      schemaVersion: 2,
      tokens: { input: 10, output: 2 },
      costSource: "unavailable",
    });
    expect(estimated).not.toHaveProperty("costUsd");

    expect(
      decodeUsageEvent(
        JSON.stringify({
          ...v1,
          agent: "claude",
          costSource: "estimated",
        }),
      ),
    ).toBeNull();
    expect(
      decodeUsageEvent(
        JSON.stringify({
          ...v1,
          agent: "claude",
          costSource: "reported",
          costUsd: 0.1,
        }),
      ),
    ).toMatchObject({
      schemaVersion: 2,
      agent: "claude",
      tokens: {},
      costSource: "provider",
      costUsd: 0.1,
      observation: { tokens: {} },
    });
  });

  it("uses a source total when present and otherwise sums buckets", () => {
    expect(tokenTotal({ input: 10, output: 2, cacheRead: 4 })).toBe(16);
    expect(tokenTotal({ total: 99, input: 10 })).toBe(99);
  });
});
