import { describe, expect, it } from "vitest";
import { achievementProgress, achievementRequirement } from "./captions";
import type { UsageAchievement } from "./catalog";

/** Captions are pure phrasing over (metric, threshold, progress) — tiers
 * are built literally here, no ladder computation involved. */
const tier = (over: Partial<UsageAchievement>): UsageAchievement => ({
  id: "tokens-1000000",
  metric: "tokens",
  threshold: 1e6,
  title: "First Million",
  icon: "🌱",
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
});
