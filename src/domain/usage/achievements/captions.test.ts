import { describe, expect, it } from "vitest";
import {
  achievementDisplayTitle,
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

describe("achievementDisplayTitle", () => {
  it("leaves a tier that has been won once alone", () => {
    expect(achievementDisplayTitle({ title: "Token Tycoon" })).toBe("Token Tycoon");
  });

  it("marks a re-earned top with an ordinal, never a multiplier", () => {
    // "×2" would claim twice the amount; the second winning sits at ten
    // times the first.
    expect(achievementDisplayTitle({ title: "Token Tycoon", repeat: 2 })).toBe(
      "Token Tycoon II",
    );
    expect(achievementDisplayTitle({ title: "Token Tycoon", repeat: 3 })).toBe(
      "Token Tycoon III",
    );
  });

  it("knows the numerals up to one past the catalog's deepest repeat", () => {
    // The catalog stops at III today; IV is the slack that lets a ladder gain
    // a fourth winning without touching this table.
    expect(achievementDisplayTitle({ title: "Legend", repeat: 4 })).toBe(
      "Legend IV",
    );
  });

  it("falls back to a plain number past the numerals it knows", () => {
    // The boundary, not a number far past it: an off-by-one in the indexing
    // shows up here and nowhere else.
    expect(achievementDisplayTitle({ title: "Legend", repeat: 5 })).toBe("Legend 5");
    expect(achievementDisplayTitle({ title: "Legend", repeat: 9 })).toBe("Legend 9");
  });

  it("treats a first winning written as repeat 1 as no mark at all", () => {
    // A stray span and a trailing space is what the view used to render.
    expect(achievementDisplayTitle({ title: "Legend", repeat: 1 })).toBe("Legend");
  });
});
