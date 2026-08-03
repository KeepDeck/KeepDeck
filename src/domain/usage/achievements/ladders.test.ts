import { describe, expect, it } from "vitest";
import { TEST_NOW, usageEvent as event } from "../history/event.testSupport";
import { achievementCatalog } from "./catalog";
import type { UsageAchievementLadder } from "./ladders";
import {
  earnedAchievements,
  lockedAchievements,
  nextAchievements,
  usageAchievementLadders,
} from "./ladders";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = TEST_NOW;

const ladder = (
  ladders: UsageAchievementLadder[],
  metric: string,
): UsageAchievementLadder =>
  ladders.find((candidate) => candidate.metric === metric)!;

describe("usageAchievementLadders", () => {
  it("dates token crossings at the ledger instant that crossed them, sorting first", () => {
    const ladders = usageAchievementLadders([
      // Deliberately unsorted: crossing math must order by occurredAt.
      event({ occurredAt: NOW - 1 * DAY, tokens: { input: 24_500_000 } }),
      event({ occurredAt: NOW - 3 * DAY, tokens: { input: 900_000 } }),
      event({ occurredAt: NOW - 2 * DAY, tokens: { input: 200_000 } }),
    ]);
    const tokens = ladder(ladders, "tokens").tiers;
    expect(tokens[0].achievedAt).toBe(NOW - 2 * DAY); // 1M
    expect(tokens[1].achievedAt).toBe(NOW - 1 * DAY); // 25M
    expect(tokens[2].achievedAt).toBeNull(); // 150M locked
    expect(tokens[2].progress).toBe(25_600_000);
  });

  it("dresses a tier exactly as the catalog does, adding only the dated fields", () => {
    // The gallery and the notifier read the same tier through different
    // producers. Assembled separately, they agree until someone adds a
    // field to one literal — and TypeScript has nothing to object to,
    // because both sides are structurally complete on their own.
    const dated = usageAchievementLadders([]).flatMap((rung) => rung.tiers);
    const flat = achievementCatalog();
    expect(dated.length).toBe(flat.length);
    dated.forEach((tier, index) => {
      const { achievedAt, progress, ...shared } = tier;
      expect(achievedAt).toBeNull();
      expect(progress).toBe(0);
      expect(shared).toEqual(flat[index]);
    });
  });

  it("accumulates provider-reported spend toward the dollar ladder", () => {
    const ladders = usageAchievementLadders([
      event({ costSource: "provider", costUsd: 6 }),
      event({ costSource: "unavailable", costUsd: undefined }),
      event({ occurredAt: NOW - 500, costSource: "provider", costUsd: 6 }),
    ]);
    const spend = ladder(ladders, "spendUsd").tiers;
    expect(spend[0]).toMatchObject({
      title: "First Dollar",
      achievedAt: NOW - 500,
      progress: 12,
    });
    expect(spend[1].achievedAt).toBeNull();
  });

  it("tracks the busiest single day and consecutive-day streaks", () => {
    const ladders = usageAchievementLadders([
      event({ occurredAt: NOW - 3 * DAY, tokens: { input: 600_000 } }),
      event({ occurredAt: NOW - 3 * DAY + 1_000, tokens: { input: 500_000 } }),
      event({ occurredAt: NOW - 2 * DAY, tokens: { input: 10 } }),
      event({ occurredAt: NOW - 1 * DAY, tokens: { input: 10 } }),
      // A gap: NOW-1d → NOW is consecutive, so streak reaches 4 in total.
    ]);
    const day = ladder(ladders, "dayTokens").tiers;
    // 1.1M inside one UTC day, crossed by the second event of that day.
    expect(day[0]).toMatchObject({
      title: "Warm Afternoon",
      achievedAt: NOW - 3 * DAY + 1_000,
    });
    const streak = ladder(ladders, "streakDays").tiers;
    expect(streak[1]).toMatchObject({
      title: "Hat-Trick",
      achievedAt: NOW - 1 * DAY, // third consecutive day
      progress: 3,
    });
  });

  it("resets a streak across a silent day", () => {
    const ladders = usageAchievementLadders([
      event({ occurredAt: NOW - 5 * DAY }),
      event({ occurredAt: NOW - 4 * DAY }),
      // NOW-3d is silent — the streak restarts.
      event({ occurredAt: NOW - 2 * DAY }),
      event({ occurredAt: NOW - 1 * DAY }),
    ]);
    const streak = ladder(ladders, "streakDays").tiers;
    // Day One lands on the first event; the three-day tier stays locked.
    expect(streak[0].achievedAt).toBe(NOW - 5 * DAY);
    expect(streak[1].achievedAt).toBeNull();
    expect(streak[1].progress).toBe(2); // longest run so far
  });

  it("counts distinct providers and models", () => {
    const ladders = usageAchievementLadders([
      event({ agent: "codex", model: "gpt-5.6-terra" }),
      event({ agent: "claude", model: "Opus 5", occurredAt: NOW - 900 }),
      event({ agent: "claude", model: "Fable 5", occurredAt: NOW - 800 }),
    ]);
    expect(ladder(ladders, "providers").tiers[0]).toMatchObject({
      title: "Two-Timer",
      achievedAt: NOW - 900,
    });
    const models = ladder(ladders, "models").tiers;
    expect(models[0]).toMatchObject({ title: "Curious", achievedAt: NOW - 800 });
  });

  it("counts one-session and one-day extremes: turns, span, spend, providers", () => {
    const sessionEvents = Array.from({ length: 100 }, (_, index) =>
      event({ occurredAt: NOW - 9 * 60 * 60 * 1_000 + index * 60_000 }),
    );
    const ladders = usageAchievementLadders([
      ...sessionEvents,
      event({ agent: "claude", occurredAt: NOW - 400 }),
      event({ agent: "kimi", occurredAt: NOW - 300 }),
      event({ agent: "opencode", occurredAt: NOW - 200 }),
    ]);
    // 100 turns in one session, spanning 99 minutes — turns earned, span not.
    expect(ladder(ladders, "sessionTurns").tiers[0].achievedAt).not.toBeNull();
    expect(ladder(ladders, "sessionHours").tiers[0]).toMatchObject({
      achievedAt: null,
    });
    // codex + claude + kimi + opencode within the same UTC day → Full House.
    expect(ladder(ladders, "dayProviders").tiers[0]).toMatchObject({
      title: "Full House",
      achievedAt: NOW - 200,
    });
  });

  it("attributes a crossing shared by same-instant events to that instant", () => {
    const at = NOW - 2 * DAY;
    const ladders = usageAchievementLadders([
      event({ occurredAt: at, tokens: { input: 600_000 } }),
      event({ occurredAt: at, tokens: { input: 600_000 }, sessionId: "s2" }),
    ]);
    // Whichever of the two ties fires the crossing, the date is the shared
    // instant — tie order cannot change the observable result.
    expect(ladder(ladders, "tokens").tiers[0].achievedAt).toBe(at);
  });

  it("sums output and cache-read tokens on their own ladders", () => {
    const ladders = usageAchievementLadders([
      event({ tokens: { input: 10, output: 1_500_000, cacheRead: 200_000_000 } }),
    ]);
    expect(ladder(ladders, "outputTokens").tiers[0]).toMatchObject({
      title: "Prolific",
      achievedAt: NOW - 1_000,
    });
    expect(ladder(ladders, "cacheTokens").tiers[0]).toMatchObject({
      title: "Warm Cache",
      achievedAt: NOW - 1_000,
    });
  });

  it("keeps every ladder locked at zero on an empty ledger", () => {
    const ladders = usageAchievementLadders([]);
    expect(ladders).toHaveLength(16);
    expect(earnedAchievements(ladders)).toEqual([]);
    for (const entry of ladders) {
      expect(entry.tiers.every((tier) => tier.achievedAt === null)).toBe(true);
    }
    // Every ladder still offers its first goal; nothing is earned, so the
    // locked tail is everything beyond those first goals.
    expect(nextAchievements(ladders)).toHaveLength(16);
    const total = ladders.reduce((sum, entry) => sum + entry.tiers.length, 0);
    expect(lockedAchievements(ladders)).toHaveLength(total - 16);
  });
});

describe("earned and next views", () => {
  it("orders the trophy case freshest first", () => {
    const ladders = usageAchievementLadders([
      event({ occurredAt: NOW - 2 * DAY, tokens: { input: 1_500_000 } }),
      event({ occurredAt: NOW - 1 * DAY, sessionId: "s2", rootSessionId: "s2" }),
    ]);
    const earned = earnedAchievements(ladders);
    expect(earned.length).toBeGreaterThan(1);
    for (let i = 1; i < earned.length; i += 1) {
      expect(earned[i - 1].achievedAt! >= earned[i].achievedAt!).toBe(true);
    }
  });

  it("offers exactly one next goal per unfinished ladder", () => {
    const ladders = usageAchievementLadders([
      event({ tokens: { input: 15_000_000 } }),
    ]);
    const next = nextAchievements(ladders);
    expect(next.every((tier) => tier.achievedAt === null)).toBe(true);
    const tokensNext = next.find((tier) => tier.metric === "tokens")!;
    expect(tokensNext.title).toBe("Picking Up Steam"); // only 1M is earned
    expect(next.filter((tier) => tier.metric === "tokens")).toHaveLength(1);
  });

  it("contributes nothing from a completed ladder", () => {
    const ladders = usageAchievementLadders([
      event({ tokens: { input: 3e11 } }),
    ]);
    expect(
      nextAchievements(ladders).find((tier) => tier.metric === "tokens"),
    ).toBeUndefined();
    expect(
      lockedAchievements(ladders).find((tier) => tier.metric === "tokens"),
    ).toBeUndefined();
  });

  it("locks every tier beyond the in-progress goal, in order", () => {
    const ladders = usageAchievementLadders([
      event({ tokens: { input: 15_000_000 } }),
    ]);
    const lockedTokens = lockedAchievements(ladders)
      .filter((tier) => tier.metric === "tokens")
      .map((tier) => tier.title);
    // 1M earned, 25M in progress → the rest are the locked tail, including
    // the two re-earned tops.
    expect(lockedTokens).toEqual([
      "Heavy Rotation",
      "Billion Club",
      "Token Tycoon",
      "Token Tycoon",
      "Token Tycoon",
    ]);
  });
});
