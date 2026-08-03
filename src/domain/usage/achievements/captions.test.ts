import { describe, expect, it } from "vitest";
import {
  achievementPercent,
  achievementProgress,
  achievementRequirement,
} from "./captions";
import type { UsageAchievement } from "./ladders";

/** Captions are pure phrasing over (metric, threshold, progress) — tiers
 * are built literally here, no ladder computation involved. */
const tier = (over: Partial<UsageAchievement>): UsageAchievement => ({
  id: "tokens-1000000",
  metric: "tokens",
  threshold: 1e6,
  title: "First Million",
  icon: "🌱",
  rarity: "common",
  achievedAt: null,
  progress: 0,
  ...over,
});

describe("captions", () => {
  it("phrases requirements and progress per metric", () => {
    const spend = tier({ metric: "spendUsd", threshold: 1, progress: 0.25 });
    expect(achievementRequirement(spend)).toBe("$1 provider-reported spend");
    expect(achievementProgress(spend)).toBe("$0.25 / $1");
    const streak = tier({ metric: "streakDays", threshold: 3, progress: 1 });
    expect(achievementRequirement(streak)).toBe("3 active days in a row");
    expect(achievementProgress(streak)).toBe("1 / 3");
    expect(achievementRequirement(tier({}))).toBe("1M tokens all-time");
  });

  it("owns the one progress-fraction rule: unfloored for the bar, capped at 100", () => {
    // The bar renders the raw fraction; the tooltip floors THIS number —
    // the two can differ in precision but never in the underlying rule.
    expect(achievementPercent({ progress: 997, threshold: 1_000 })).toBeCloseTo(99.7);
    expect(achievementPercent({ progress: 2_000, threshold: 1_000 })).toBe(100);
    expect(achievementPercent({ progress: 0, threshold: 1_000 })).toBe(0);
  });
});
