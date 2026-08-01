import { describe, expect, it } from "vitest";
import { usageAchievements } from "./achievements";
import type { UsageEventV2 } from "./history";

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

describe("usageAchievements", () => {
  it("returns the full catalog with locked entries carrying progress", () => {
    const achievements = usageAchievements([
      event({ tokens: { input: 2_000_000 } }),
    ]);

    expect(achievements).toHaveLength(11); // 7 token + 4 session tiers
    const first = achievements[0];
    expect(first).toMatchObject({
      id: "tokens-1000000",
      title: "First Million",
      achievedAt: NOW - 1_000,
    });
    const second = achievements[1];
    expect(second).toMatchObject({
      title: "Picking Up Steam",
      achievedAt: null,
      progress: 2_000_000,
      threshold: 1e7,
    });
    const sessions = achievements[7];
    expect(sessions).toMatchObject({
      id: "sessions-10",
      achievedAt: null,
      progress: 1,
    });
  });

  it("dates each crossing at the ledger instant that crossed it, sorting first", () => {
    const achievements = usageAchievements([
      // Deliberately unsorted: crossing math must order by occurredAt.
      event({ occurredAt: NOW - 1 * DAY, tokens: { input: 9_500_000 } }),
      event({ occurredAt: NOW - 3 * DAY, tokens: { input: 900_000 } }),
      event({ occurredAt: NOW - 2 * DAY, tokens: { input: 200_000 } }),
    ]);
    expect(achievements[0].achievedAt).toBe(NOW - 2 * DAY); // 1M
    expect(achievements[1].achievedAt).toBe(NOW - 1 * DAY); // 10M
    expect(achievements[2].achievedAt).toBeNull(); // 100M still locked
  });

  it("counts distinct sessions, not events, toward session tiers", () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      event({
        occurredAt: NOW - (12 - index) * 60_000,
        sessionId: `session-${index % 10}`,
        rootSessionId: `session-${index % 10}`,
      }),
    );
    const achievements = usageAchievements(events);
    const firstSteps = achievements.find((item) => item.id === "sessions-10")!;
    expect(firstSteps.achievedAt).toBe(NOW - 3 * 60_000);
    const century = achievements.find((item) => item.id === "sessions-100")!;
    expect(century).toMatchObject({ achievedAt: null, progress: 10 });
  });

  it("keeps the whole catalog locked at zero progress on an empty ledger", () => {
    const achievements = usageAchievements([]);
    expect(achievements).toHaveLength(11);
    expect(achievements.every((item) => item.achievedAt === null)).toBe(true);
    expect(achievements.every((item) => item.progress === 0)).toBe(true);
  });
});
