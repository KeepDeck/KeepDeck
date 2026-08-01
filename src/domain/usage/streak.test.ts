import { describe, expect, it } from "vitest";
import { TEST_NOW, usageEvent } from "./history.testSupport";
import { currentStreakDays, streakHeat } from "./streak";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = TEST_NOW;

const event = (occurredAt: number) =>
  usageEvent({ occurredAt, capturedAt: occurredAt });

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
