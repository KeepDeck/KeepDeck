import { describe, expect, it } from "vitest";
import { TEST_NOW } from "./history/event.testSupport";
import { currentStreakDays, streakHeat } from "./streak";

/** Instants, not events: the function is about days, and who witnessed an
 * instant — a recorded spend or a live report — is the caller's question. */
const DAY = 24 * 60 * 60 * 1_000;
const NOW = TEST_NOW;

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
});

describe("what counts as being active", () => {
  it("takes any instant as evidence, whoever witnessed it", () => {
    // The point of the signature. A recorded spend and a live report are
    // both proof that the reader was here; the function does not ask which
    // it is holding, and that is why the count no longer waits for the
    // first turn to finish before noticing today.
    const spendYesterday = NOW - 1 * DAY;
    const reportToday = NOW - 1_000;
    expect(currentStreakDays([spendYesterday], NOW)).toBe(1);
    expect(currentStreakDays([spendYesterday, reportToday], NOW)).toBe(2);
  });

  it("ignores an instant from the future rather than opening a day for it", () => {
    // A clock-skewed report must not invent tomorrow and break the chain.
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
