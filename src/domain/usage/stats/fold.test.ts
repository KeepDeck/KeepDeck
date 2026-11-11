import { describe, expect, it } from "vitest";
import { usageEvent } from "../history/event.testSupport";
import { inZone } from "../time.testSupport";
import {
  breakdown,
  COMPARABLE_UNPRICED,
  comparablyPriced,
  costChange,
  costTimeline,
  OTHER_KEY,
  rowsIn,
  rowsOf,
  statsTotals,
} from "./fold";

const at = (iso: string) => new Date(iso).getTime();
const HOUR = 3_600_000;

describe("span totals", () => {
  it("adds money through the cost tally and never counts unpriced usage as free", () => {
    const totals = statsTotals([
      usageEvent({ costUsd: 2, tokens: { input: 100, output: 40 } }),
      usageEvent({ tokens: { input: 50, output: 10 } }),
    ]);
    expect(totals).toMatchObject({ costUsd: 2, pricedEvents: 1, unpricedTokens: 60, totalTokens: 200, outputTokens: 50 });
  });

  it("adds what the cache saved on priced rows, the core's estimate carried as served", () => {
    const totals = statsTotals([
      usageEvent({ costUsd: 1, savedUsd: 3.5 }),
      usageEvent({ costUsd: 1, savedUsd: 0.5 }),
      // An unpriced row carries no saving at all.
      usageEvent({ savedUsd: 9 }),
    ]);
    expect(totals.savedUsd).toBe(4);
  });

  it("counts distinct agent sessions, not rows — the same id under two agents is two", () => {
    const totals = statsTotals([
      usageEvent({ agent: "codex", sessionId: "s1" }),
      usageEvent({ agent: "codex", sessionId: "s1" }),
      usageEvent({ agent: "claude", sessionId: "s1" }),
    ]);
    expect(totals.sessions).toBe(2);
  });

  it("is all zeros for no rows", () => {
    expect(statsTotals([])).toMatchObject({ costUsd: 0, pricedEvents: 0, totalTokens: 0, sessions: 0 });
  });

  it("narrows rows to one workspace by name, and keeps every one for none", () => {
    const rows = [usageEvent({ workspaceName: "A" }), usageEvent({ workspaceName: "B" })];
    expect(rowsOf(rows, "B")).toEqual([rows[1]]);
    expect(rowsOf(rows, null)).toBe(rows);
  });

  it("cuts rows to a half-open span", () => {
    const rows = [usageEvent({ occurredAt: 10 }), usageEvent({ occurredAt: 20 })];
    expect(rowsIn(rows, { from: 10, to: 20 })).toEqual([rows[0]]);
  });
});

describe("the money comparison", () => {
  const span = (costUsd: number, totalTokens: number, unpricedTokens: number, pricedEvents = 1) => ({
    costUsd, totalTokens, unpricedTokens, pricedEvents, approximateEvents: 0, savedUsd: 0, outputTokens: 0, sessions: 1,
  });

  it("is the relative change when both spans are comparably priced", () => {
    expect(costChange(span(80, 1000, 30), span(100, 1000, 11))).toBeCloseTo(-0.2);
  });

  it("refuses a span with too much unpriced usage, at the user's threshold", () => {
    expect(comparablyPriced(span(10, 1000, COMPARABLE_UNPRICED * 1000))).toBe(true);
    expect(comparablyPriced(span(10, 1000, COMPARABLE_UNPRICED * 1000 + 1))).toBe(false);
    expect(costChange(span(10, 1000, 500), span(10, 1000, 0))).toBeNull();
    expect(costChange(span(10, 1000, 0), span(10, 1000, 500))).toBeNull();
  });

  it("refuses a side with no priced usage — never a −100% for usage that went unpriced", () => {
    expect(costChange(span(0, 100, 0, 0), span(10, 100, 0))).toBeNull();
    expect(costChange(span(10, 100, 0), span(0, 100, 0, 0))).toBeNull();
  });

  it("has nothing to compare with a prior span that spent nothing, or no prior span", () => {
    expect(costChange(span(10, 100, 0), span(0, 100, 0))).toBeNull();
    expect(costChange(span(10, 100, 0), null)).toBeNull();
  });
});

describe("money over time", () => {
  it("fills every local day of the span, quiet ones included, split by agent", () => {
    inZone("Asia/Nicosia", () => {
      const span = { from: at("2026-11-08T00:00:00+02:00"), to: at("2026-11-10T09:00:00+02:00") + 1 };
      const steps = costTimeline(
        [
          usageEvent({ occurredAt: at("2026-11-08T00:30:00+02:00"), agent: "claude", costUsd: 3 }),
          usageEvent({ occurredAt: at("2026-11-08T23:30:00+02:00"), agent: "codex", costUsd: 1 }),
          usageEvent({ occurredAt: at("2026-11-10T08:00:00+02:00"), agent: "claude", tokens: { input: 9 } }),
        ],
        span,
        "day",
      );
      expect(steps.map((s) => s.start)).toEqual([
        at("2026-11-08T00:00:00+02:00"), at("2026-11-09T00:00:00+02:00"), at("2026-11-10T00:00:00+02:00"),
      ]);
      // 00:30 local is the 8th here even though it is the 7th in UTC.
      expect(steps[0]).toMatchObject({ costUsd: 4, byAgent: { claude: 3, codex: 1 } });
      expect(steps[1]).toMatchObject({ costUsd: 0, pricedEvents: 0 });
      // An unpriced-only day says so: no money, but unpriced tokens.
      expect(steps[2]).toMatchObject({ costUsd: 0, pricedEvents: 0, unpricedTokens: 9 });
    });
  });

  it("steps from local midnight to local midnight across a 25-hour day", () => {
    inZone("Europe/Berlin", () => {
      const span = { from: at("2026-10-24T00:00:00+02:00"), to: at("2026-10-26T12:00:00+01:00") };
      const steps = costTimeline([usageEvent({ occurredAt: at("2026-10-26T00:30:00+01:00"), costUsd: 2 })], span, "day");
      expect(steps.map((step) => step.start)).toEqual([
        at("2026-10-24T00:00:00+02:00"), at("2026-10-25T00:00:00+02:00"), at("2026-10-26T00:00:00+01:00"),
      ]);
      expect(steps[2]?.costUsd).toBe(2);
    });
  });

  it("steps by hour for one day, through to the current hour", () => {
    inZone("Asia/Nicosia", () => {
      const from = at("2026-11-10T00:00:00+02:00");
      const steps = costTimeline([usageEvent({ occurredAt: from + 2 * HOUR + 5, costUsd: 1 })], { from, to: from + 3 * HOUR + 10 }, "hour");
      expect(steps.map((s) => (s.start - from) / HOUR)).toEqual([0, 1, 2, 3]);
      expect(steps[2]?.costUsd).toBe(1);
    });
  });

  it("starts an open span at its first row, and is empty without rows", () => {
    inZone("Asia/Nicosia", () => {
      const first = at("2026-11-09T10:00:00+02:00");
      const span = { from: -Infinity, to: at("2026-11-10T10:00:00+02:00") };
      expect(costTimeline([usageEvent({ occurredAt: first, costUsd: 1 })], span, "day")).toHaveLength(2);
      expect(costTimeline([], span, "day")).toEqual([]);
    });
  });
});

describe("a breakdown", () => {
  const byWorkspace = (row: { workspaceName: string }) => row.workspaceName;

  it("ranks groups by priced cost with shares of the span, each against its own prior", () => {
    const rows = breakdown(
      [
        usageEvent({ workspaceName: "A", costUsd: 3 }),
        usageEvent({ workspaceName: "B", costUsd: 1, occurredAt: 5 }),
        usageEvent({ workspaceName: "B", costUsd: 4, occurredAt: 9 }),
      ],
      [usageEvent({ workspaceName: "B", costUsd: 10 })],
      byWorkspace,
      5,
    );
    expect(rows.map((r) => [r.key, r.costUsd, r.share])).toEqual([["B", 5, 0.625], ["A", 3, 0.375]]);
    expect(rows[0]?.change).toBeCloseTo(-0.5);
    // No prior usage: no change, not +∞.
    expect(rows[1]?.change).toBeNull();
    expect(rows[0]?.latest.occurredAt).toBe(9);
  });

  it("shows a list one longer than the limit whole, and folds a longer tail from its raw rows", () => {
    const four = ["A", "B", "C", "D"].map((w, i) => usageEvent({ workspaceName: w, costUsd: 10 - i, sessionId: "shared" }));
    expect(breakdown(four.slice(0, 3), [], byWorkspace, 2).every((r) => r.folded === 0)).toBe(true);
    const rows = breakdown(four, [], byWorkspace, 2);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ key: OTHER_KEY, folded: 2, costUsd: 15 });
    // One session across both folded groups counts once, not twice.
    expect(rows[2]?.sessions).toBe(1);
    expect(rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1);
  });

  it("splits a group's priced cost by agent", () => {
    const [row] = breakdown(
      [usageEvent({ agent: "claude", costUsd: 2 }), usageEvent({ agent: "codex", costUsd: 1 }), usageEvent({ agent: "kimi" })],
      [],
      () => "all",
      5,
    );
    expect({ ...row?.byAgent }).toEqual({ claude: 2, codex: 1 });
  });
});
