import { describe, expect, it } from "vitest";
import { TEST_NOW } from "./history/event.testSupport";
import { currentStreakDays, streakHeat } from "./streak";

/** Instants, not events: the function is about days, and who witnessed an
 * instant — a recorded spend or a live report — is the caller's question,
 * answered by `createActivityWitness` and tested there. */
const DAY = 24 * 60 * 60 * 1_000;
const NOW = TEST_NOW;

/** Run a body in a FIXED zone, whatever the runner is in. Node re-reads
 * `process.env.TZ` for each Date operation, so this genuinely pins a real
 * transition rather than hoping CI happens to sit in a zone that has one. */
function inZone(tz: string, body: () => void): void {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    body();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

describe("the day a streak counts in", () => {
  /** Local midnight, whatever zone the suite runs in. */
  const midnight = (dayOffset = 0) => {
    const date = new Date(NOW);
    date.setHours(0, 0, 0, 0);
    return date.getTime() + dayOffset * DAY;
  };

  it("turns over at the reader's midnight, not at UTC's", () => {
    // THE bug. Bucketing on `floor(t / DAY_MS)` puts the boundary at UTC
    // midnight, so at UTC+3 a session at 00:30 local landed on yesterday
    // and the day it actually happened on read as empty. Half past
    // midnight and half past eleven at night are the same local day here,
    // and in most zones they are NOT the same UTC day.
    const justAfterMidnight = midnight() + 30 * 60_000;
    const lateTonight = midnight() + 23 * 60 * 60_000 + 30 * 60_000;
    const later = midnight() + 12 * 60 * 60_000;
    expect(currentStreakDays([justAfterMidnight], later)).toBe(1);
    // Yesterday plus today is two, counted from the reader's calendar.
    expect(
      currentStreakDays([midnight(-1) + 60_000, justAfterMidnight], later),
    ).toBe(2);
    // And a late-night session belongs to the day it feels like, not the
    // next one — one active day, not two.
    expect(
      currentStreakDays([justAfterMidnight, lateTonight], lateTonight),
    ).toBe(1);
  });

  it("advances by exactly one across a day of any length", () => {
    // Counting calendar days rather than dividing elapsed milliseconds is
    // what makes a 23- or 25-hour DST day still worth one day.
    const days = [4, 3, 2, 1, 0].map((back) => midnight(-back) + 9 * 60 * 60_000);
    expect(currentStreakDays(days, midnight() + 20 * 60 * 60_000)).toBe(5);
  });

  it.each([
    ["springs forward", 2, 8, 23],
    ["falls back", 10, 1, 25],
  ])("holds across a day that %s", (_label, month, day, hours) => {
    // The case above cannot actually prove its own claim: its instants are a
    // fixed 24h apart from a JULY fixture, so no real zone has a transition
    // in that window and the assertion passes under a rule that divides
    // elapsed milliseconds — the very rule this function exists to avoid.
    // Here the zone is PINNED, because the suite's own is not (no TZ is set
    // in the vitest config), and in UTC there is no DST to cross.
    inZone("America/New_York", () => {
      const noon = (of: number) => new Date(2026, month, of, 12, 0).getTime();
      // The transition sits at 02:00, so the odd-length span is the one
      // ENDING at this day's noon. Asserting it is what stops the case from
      // quietly degenerating into three ordinary days if a date ever drifts.
      expect((noon(day) - noon(day - 1)) / 3_600_000).toBe(hours);
      const run = [noon(day - 2), noon(day - 1), noon(day)];
      expect(currentStreakDays(run, noon(day) + 6 * 3_600_000)).toBe(3);
    });
  });
});

describe("what counts as being active", () => {
  it("ignores an instant from the future rather than opening a day for it", () => {
    // A skewed clock's row in the never-pruned ledger must not invent
    // tomorrow — which would anchor the walk a day early and break the chain
    // at today. WHO produced the instant is not asked here on purpose; that
    // is the witness's question.
    expect(currentStreakDays([NOW - 1_000, NOW + 2 * DAY], NOW)).toBe(1);
  });
});

describe("currentStreakDays", () => {
  it("counts consecutive days ending today", () => {
    expect(
      currentStreakDays([NOW - 1_000, NOW - 1 * DAY, NOW - 2 * DAY], NOW),
    ).toBe(3);
  });

  it("survives an inactive today while yesterday was active", () => {
    expect(currentStreakDays([NOW - 1 * DAY, NOW - 2 * DAY], NOW)).toBe(2);
  });

  it("breaks on an inactive yesterday", () => {
    expect(currentStreakDays([NOW - 2 * DAY], NOW)).toBe(0);
  });

  it("restarts after a gap instead of bridging it", () => {
    expect(
      currentStreakDays([NOW - 1_000, NOW - 1 * DAY, NOW - 3 * DAY], NOW),
    ).toBe(2);
  });

  it("is zero with nothing to go on", () => {
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
