import { describe, expect, it } from "vitest";
import { bucketShares, usageAgents, usageTimeline } from "./daily";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
import { TEST_NOW, usageEvent as event } from "./history/event.testSupport";

const NOW = TEST_NOW;
const TODAY = Date.parse("2026-07-22T00:00:00.000Z");


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
    // 7d cutoff lands on Jul 15 12:00 → Jul 15 is only HALF in view, so the
    // axis opens at Jul 16, the first fully covered day: a bar labeled with
    // a day must cover that whole day.
    expect(timeline.buckets).toHaveLength(7);
    expect(timeline.buckets[0].start).toBe(TODAY - 6 * DAY);
    // Each slice carries the authoritative total AND the split behind it —
    // the chart draws the first, its hover card explains it with the second.
    expect(timeline.buckets[timeline.buckets.length - 1]).toEqual({
      start: TODAY,
      byAgent: {
        codex: { totalTokens: 100, tokens: { input: 100 } },
        claude: { totalTokens: 40, tokens: { input: 40 } },
      },
    });
    expect(timeline.buckets[4].byAgent).toEqual({
      codex: { totalTokens: 300, tokens: { input: 300 } },
    });
    expect(timeline.buckets[1].byAgent).toEqual({}); // silent day stays visible
    expect(timeline.agents).toEqual(["claude", "codex"]); // fixed alphabetical order
  });

  it("drops the partial leading bucket but keeps a boundary-aligned one", () => {
    // An in-window event on the half-covered Jul 15 afternoon must not
    // produce a "Jul 15" bar that silently understates that day.
    const sliver = usageTimeline(
      [
        event({ occurredAt: NOW - 7 * DAY + 1_000, tokens: { input: 9_999 } }),
        event({ occurredAt: NOW - 1_000, tokens: { input: 100 } }),
      ],
      7,
      NOW,
    );
    expect(sliver.buckets[0].start).toBe(TODAY - 6 * DAY);
    expect(
      sliver.buckets.every(
        (bucket) => bucket.byAgent.codex?.totalTokens !== 9_999,
      ),
    ).toBe(true);
    // A cutoff sitting exactly on a bucket boundary loses nothing.
    const aligned = usageTimeline(
      [event({ occurredAt: NOW - 1_000, tokens: { input: 100 } })],
      1,
      NOW,
    );
    expect(aligned.buckets[0].start).toBe(NOW - 24 * HOUR);
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
    // NOW sits exactly on 12:00, so the cutoff is bucket-aligned and its
    // bucket is fully covered: 12:00 yesterday … 12:00 today inclusive.
    expect(timeline.buckets).toHaveLength(25);
    const at = (hoursAgo: number) =>
      timeline.buckets.find((bucket) => bucket.start === NOW - hoursAgo * HOUR)!;
    // the 11:00 bucket
    expect(at(1).byAgent).toEqual({
      codex: { totalTokens: 100, tokens: { input: 100 } },
    });
    expect(at(5).byAgent).toEqual({
      codex: { totalTokens: 40, tokens: { input: 40 } },
    });
    expect(at(0).byAgent).toEqual({}); // the freshly opened hour is empty
  });

  it("names a bucket's providers in roster order, absent ones omitted", () => {
    // The hover card is read by running the cursor along the bars: rows that
    // re-sort by size under a moving cursor cannot be compared to anything.
    const timeline = usageTimeline(
      [
        event({ occurredAt: NOW - 1_000, tokens: { input: 100, cacheRead: 900 } }),
        event({
          occurredAt: NOW - 1_500,
          agent: "claude",
          tokens: { input: 40, output: 10 },
        }),
        // A provider on the roster that this bucket never saw.
        event({ occurredAt: NOW - 3 * DAY, agent: "kimi", tokens: { input: 7 } }),
      ],
      7,
      NOW,
    );
    const today = timeline.buckets[timeline.buckets.length - 1];
    expect(timeline.agents).toEqual(["claude", "codex", "kimi"]);
    expect(bucketShares(today, timeline.agents)).toEqual([
      { agent: "claude", totalTokens: 50, tokens: { input: 40, output: 10 } },
      { agent: "codex", totalTokens: 1_000, tokens: { input: 100, cacheRead: 900 } },
    ]);
    // Alphabetical roster order, NOT the 1000-then-50 size order.
    expect(bucketShares(today, timeline.agents).map((s) => s.agent)).toEqual([
      "claude",
      "codex",
    ]);
    // A silent bucket has nobody to name, so the card renders nothing.
    expect(bucketShares(timeline.buckets[1], timeline.agents)).toEqual([]);
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
    ).toEqual({ granularity: "day", bucketMs: DAY, buckets: [], agents: [] });
  });

  it("names its granularity so labels and titles never guess from widths", () => {
    expect(usageTimeline([event()], 1, NOW).granularity).toBe("hour");
    expect(usageTimeline([event()], 7, NOW).granularity).toBe("day");
  });
});
