import { describe, expect, it } from "vitest";
import type { UsageEventV2 } from "./history";
import { currentStreakDays, streakHeat } from "./streak";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse("2026-07-22T12:00:00.000Z");

let seq = 0;
const event = (occurredAt: number): UsageEventV2 =>
  ({
    schemaVersion: 2,
    eventId: `event-${(seq += 1)}`,
    occurredAt,
    capturedAt: occurredAt,
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
  }) as UsageEventV2;

describe("currentStreakDays", () => {
  it("counts consecutive days ending today", () => {
    expect(
      currentStreakDays(
        [event(NOW - 1_000), event(NOW - 1 * DAY), event(NOW - 2 * DAY)],
        NOW,
      ),
    ).toBe(3);
  });

  it("survives an inactive today while yesterday was active", () => {
    expect(
      currentStreakDays([event(NOW - 1 * DAY), event(NOW - 2 * DAY)], NOW),
    ).toBe(2);
  });

  it("breaks on an inactive yesterday", () => {
    expect(currentStreakDays([event(NOW - 2 * DAY)], NOW)).toBe(0);
  });

  it("restarts after a gap instead of bridging it", () => {
    expect(
      currentStreakDays(
        [event(NOW - 1_000), event(NOW - 1 * DAY), event(NOW - 3 * DAY)],
        NOW,
      ),
    ).toBe(2);
  });

  it("is zero on an empty ledger", () => {
    expect(currentStreakDays([], NOW)).toBe(0);
  });
});

describe("streakHeat", () => {
  it("escalates through the tiers", () => {
    expect(streakHeat(1)).toBe("none");
    expect(streakHeat(2)).toBe("none");
    expect(streakHeat(3)).toBe("ember");
    expect(streakHeat(7)).toBe("flame");
    expect(streakHeat(30)).toBe("blaze");
    expect(streakHeat(100)).toBe("inferno");
  });
});
