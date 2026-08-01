import { describe, expect, it } from "vitest";
import type { UsageEventV2 } from "./history";
import { usageMilestones } from "./milestones";

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

describe("usageMilestones", () => {
  it("dates each crossing at the ledger instant that crossed it", () => {
    const milestones = usageMilestones([
      // Deliberately unsorted: the crossing math must order by occurredAt.
      event({ occurredAt: NOW - 1 * DAY, tokens: { input: 9_500_000 } }),
      event({ occurredAt: NOW - 3 * DAY, tokens: { input: 900_000 } }),
      event({ occurredAt: NOW - 2 * DAY, tokens: { input: 200_000 } }),
    ]);

    expect(milestones.earned).toEqual([
      { kind: "tokens", threshold: 1e6, achievedAt: NOW - 2 * DAY },
      { kind: "tokens", threshold: 1e7, achievedAt: NOW - 1 * DAY },
    ]);
    expect(milestones.nextTokens).toEqual({
      threshold: 1e8,
      totalTokens: 10_600_000,
    });
  });

  it("counts distinct sessions toward the session ladder", () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      event({
        occurredAt: NOW - (12 - index) * 60_000,
        sessionId: `session-${index % 10}`, // 10 distinct, 12 events
        rootSessionId: `session-${index % 10}`,
      }),
    );
    const milestones = usageMilestones(events);
    expect(milestones.earned).toEqual([
      { kind: "sessions", threshold: 10, achievedAt: NOW - 3 * 60_000 },
    ]);
  });

  it("runs out of ladder gracefully", () => {
    const milestones = usageMilestones([
      event({ tokens: { input: 2e12 } }),
    ]);
    expect(milestones.earned.map((item) => item.threshold)).toEqual([
      1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12,
    ]);
    expect(milestones.nextTokens).toBeNull();
  });

  it("is empty with a first milestone ahead on an empty ledger", () => {
    expect(usageMilestones([])).toEqual({
      earned: [],
      nextTokens: { threshold: 1e6, totalTokens: 0 },
    });
  });
});
