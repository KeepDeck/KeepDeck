import { describe, expect, it } from "vitest";
import {
  decodeUsageEvent,
  decodeUsageEventLine,
  encodeUsageEvent,
  tokenTotal,
  type UsageEventV2,
} from "./event";

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

  it("rejects a line whose capture instant is itself epoch", () => {
    // The clamp heals TOWARD capturedAt; a zero capture would launder an
    // epoch observation straight past it and poison every all-time view.
    expect(
      decodeUsageEventLine(
        JSON.stringify({ ...event, occurredAt: 0, capturedAt: 0 }),
      ),
    ).toBeNull();
  });

  it("clamps epoch and future occurredAt to capturedAt, marking the line for compaction", () => {
    const epoch = JSON.stringify({ ...event, occurredAt: 0 });
    const decodedEpoch = decodeUsageEventLine(epoch)!;
    expect(decodedEpoch.event.occurredAt).toBe(event.capturedAt);
    expect(decodedEpoch.migrated).toBe(true); // heals on the next compaction

    const future = JSON.stringify({ ...event, occurredAt: event.capturedAt + 5 });
    const decodedFuture = decodeUsageEventLine(future)!;
    expect(decodedFuture.event.occurredAt).toBe(event.capturedAt);
    expect(decodedFuture.migrated).toBe(true);

    // A legitimately old instant (a replay with a real source time) passes.
    const old = JSON.stringify({ ...event, occurredAt: 3 });
    const decodedOld = decodeUsageEventLine(old)!;
    expect(decodedOld.event.occurredAt).toBe(3);
    expect(decodedOld.migrated).toBe(false);
  });

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
