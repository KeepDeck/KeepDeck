import { describe, expect, it } from "vitest";
import {
  decodeUsageEvent,
  encodeUsageEvent,
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
