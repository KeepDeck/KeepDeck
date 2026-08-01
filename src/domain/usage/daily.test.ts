import { describe, expect, it } from "vitest";
import { usageAgents, usageTimeline } from "./daily";
import type { UsageEventV2 } from "./history";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
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

describe("usageTimeline", () => {
  it("buckets by UTC day, zero-filling silent days across the period", () => {
    const timeline = usageTimeline(
      [
        event({ occurredAt: NOW - 1_000, tokens: { input: 100 } }),
        event({ occurredAt: NOW - 1_500, agent: "claude", tokens: { input: 40 } }),
        event({ occurredAt: NOW - 2 * DAY, tokens: { input: 300 } }),
        event({ occurredAt: NOW - 20 * DAY, tokens: { input: 9_999 } }), // outside 7d
      ],
      7,
      NOW,
    );

    expect(timeline.bucketMs).toBe(DAY);
    // 7d cutoff lands on Jul 15 12:00 → its UTC day opens the axis.
    expect(timeline.buckets).toHaveLength(8);
    expect(timeline.buckets[0].start).toBe(TODAY - 7 * DAY);
    expect(timeline.buckets[timeline.buckets.length - 1]).toEqual({
      start: TODAY,
      byAgent: { codex: 100, claude: 40 },
    });
    expect(timeline.buckets[5].byAgent).toEqual({ codex: 300 });
    expect(timeline.buckets[1].byAgent).toEqual({}); // silent day stays visible
    expect(timeline.agents).toEqual(["claude", "codex"]); // fixed alphabetical order
  });

  it("buckets the 24h period by hour — day bars there read as a broken chart", () => {
    const timeline = usageTimeline(
      [
        event({ occurredAt: NOW - 30 * 60_000, tokens: { input: 100 } }),
        event({ occurredAt: NOW - 5 * HOUR, tokens: { input: 40 } }),
      ],
      1,
      NOW,
    );
    expect(timeline.bucketMs).toBe(HOUR);
    // NOW sits exactly on 12:00 → hourly buckets 12:00 yesterday … 12:00 today.
    expect(timeline.buckets).toHaveLength(25);
    const at = (hoursAgo: number) =>
      timeline.buckets.find((bucket) => bucket.start === NOW - hoursAgo * HOUR)!;
    expect(at(1).byAgent).toEqual({ codex: 100 }); // the 11:00 bucket
    expect(at(5).byAgent).toEqual({ codex: 40 });
    expect(at(0).byAgent).toEqual({}); // the freshly opened hour is empty
  });

  it("spans from the first recorded bucket for the all period", () => {
    const timeline = usageTimeline(
      [
        event({ occurredAt: NOW - 3 * DAY, tokens: { input: 50 } }),
        event({ occurredAt: NOW }),
      ],
      "all",
      NOW,
    );
    expect(timeline.buckets).toHaveLength(4);
    expect(timeline.buckets[0].start).toBe(TODAY - 3 * DAY);
  });

  it("lists the full-ledger agent roster regardless of period", () => {
    expect(
      usageAgents([
        event({ agent: "zeta", occurredAt: NOW - 100 * DAY }),
        event({ agent: "codex" }),
        event({ agent: "codex" }),
      ]),
    ).toEqual(["codex", "zeta"]);
  });

  it("is empty when the period has no events", () => {
    expect(
      usageTimeline([event({ occurredAt: NOW - 20 * DAY })], 7, NOW),
    ).toEqual({ bucketMs: DAY, buckets: [], agents: [] });
  });
});
