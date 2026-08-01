import { describe, expect, it } from "vitest";
import { dailyUsage } from "./daily";
import type { UsageEventV2 } from "./history";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const TODAY = Date.parse("2026-07-22T00:00:00.000Z");

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

describe("dailyUsage", () => {
  it("buckets by UTC day, zero-filling silent days across the period", () => {
    const daily = dailyUsage(
      [
        event({ occurredAt: NOW - 1_000, tokens: { input: 100 } }),
        event({ occurredAt: NOW - 1_500, agent: "claude", tokens: { input: 40 } }),
        event({ occurredAt: NOW - 2 * DAY, tokens: { input: 300 } }),
        event({ occurredAt: NOW - 20 * DAY, tokens: { input: 9_999 } }), // outside 7d
      ],
      7,
      NOW,
    );

    // 7d cutoff lands on Jul 15 12:00 → its UTC day opens the axis.
    expect(daily.days).toHaveLength(8);
    expect(daily.days[0].dayStart).toBe(TODAY - 7 * DAY);
    expect(daily.days[daily.days.length - 1]).toEqual({
      dayStart: TODAY,
      byAgent: { codex: 100, claude: 40 },
    });
    expect(daily.days[5].byAgent).toEqual({ codex: 300 });
    expect(daily.days[1].byAgent).toEqual({}); // silent day stays visible
    expect(daily.agents).toEqual(["claude", "codex"]); // fixed alphabetical order
  });

  it("spans from the first recorded day for the all period", () => {
    const daily = dailyUsage(
      [
        event({ occurredAt: NOW - 3 * DAY, tokens: { input: 50 } }),
        event({ occurredAt: NOW }),
      ],
      "all",
      NOW,
    );
    expect(daily.days).toHaveLength(4);
    expect(daily.days[0].dayStart).toBe(TODAY - 3 * DAY);
  });

  it("is empty when the period has no events", () => {
    expect(dailyUsage([event({ occurredAt: NOW - 20 * DAY })], 7, NOW)).toEqual({
      days: [],
      agents: [],
    });
  });
});
