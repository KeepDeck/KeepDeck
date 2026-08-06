import { describe, expect, it } from "vitest";
import { TEST_NOW, usageEvent } from "./history/event.testSupport";
import { currentStreakDays, streakHeat } from "./streak";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = TEST_NOW;

const event = (occurredAt: number) =>
  usageEvent({ occurredAt, capturedAt: occurredAt });

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
    expect(currentStreakDays([event(justAfterMidnight)], later)).toBe(1);
    // Yesterday plus today is two, counted from the reader's calendar.
    expect(
      currentStreakDays([event(midnight(-1) + 60_000), event(justAfterMidnight)], later),
    ).toBe(2);
    // And a late-night session belongs to the day it feels like, not the
    // next one — one active day, not two.
    expect(
      currentStreakDays([event(justAfterMidnight), event(lateTonight)], lateTonight),
    ).toBe(1);
  });

  it("advances by exactly one across a day of any length", () => {
    // Counting calendar days rather than dividing elapsed milliseconds is
    // what makes a 23- or 25-hour DST day still worth one day.
    const days = [4, 3, 2, 1, 0].map((back) => event(midnight(-back) + 9 * 60 * 60_000));
    expect(currentStreakDays(days, midnight() + 20 * 60 * 60_000)).toBe(5);
  });
});

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
