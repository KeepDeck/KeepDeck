import { describe, expect, it } from "vitest";
import {
  achievementExact,
  achievementProgress,
} from "../../domain/usage/achievements/captions";
import type { UsageAchievement, UsageAchievementLadder } from "../../domain/usage/achievements/ladders";
import {
  achievementCardView,
  achievementSections,
  rimDrift,
  rimPhase,
  wearsEmbers,
} from "./achievementView";

const EARNED_AT = Date.parse("2026-07-22T12:00:00.000Z");

const badge = (over: Partial<UsageAchievement> = {}): UsageAchievement => ({
  id: "sessions-10",
  metric: "sessions",
  threshold: 10,
  title: "Regular",
  icon: "🗓",
  rarity: "common",
  achievedAt: null,
  progress: 4,
  ...over,
  // Earned when the ledger dated it, unless a case says otherwise.
  earned: over.earned ?? (over.achievedAt ?? null) !== null,
});

describe("wearsEmbers", () => {
  it("lights an earned legendary alone, never the promise of one", () => {
    expect(wearsEmbers(badge({ rarity: "legendary", achievedAt: EARNED_AT }))).toBe(true);
    expect(wearsEmbers(badge({ rarity: "legendary" }))).toBe(false);
    expect(wearsEmbers(badge({ rarity: "epic", achievedAt: EARNED_AT }))).toBe(false);
  });
});

describe("the rim's per-badge numbers", () => {
  const ids = ["tokens-25000000", "tokens-50000000", "tokens-100000000", "sessions-10", "streak-7"];

  it("are the same for a badge every time — derived, never rolled", () => {
    for (const id of ids) {
      expect(rimDrift(id)).toBe(rimDrift(id));
      expect(rimPhase(id)).toBe(rimPhase(id));
    }
  });

  it("keep the pace within its drift of the level's, and the start within one turn", () => {
    for (const id of ids) {
      expect(Math.abs(rimDrift(id) - 1)).toBeLessThanOrEqual(0.05);
      expect(rimPhase(id)).toBeGreaterThanOrEqual(0);
      expect(rimPhase(id)).toBeLessThan(1);
    }
  });

  it("set badges that differ only in their tail apart", () => {
    const phases = ids.map(rimPhase);
    expect(new Set(phases).size).toBe(ids.length);
    // A badge's pace says nothing about where its light starts.
    expect(ids.map(rimDrift).map((drift) => (drift - 0.95) / 0.1)).not.toEqual(phases);
  });
});

describe("achievementCardView", () => {
  it("says when an earned badge was earned, on the card and in its tip", () => {
    const card = achievementCardView(badge({ achievedAt: EARNED_AT, rarity: "rare" }), false);
    expect(card).toMatchObject({
      locked: false,
      rarityLabel: "Rare",
      status: { kind: "earned", text: "earned Jul 22, 2026" },
      tipStatus: "Earned Jul 22, 2026",
    });
  });

  it("shows how far a badge being worked toward has come, with the exact numbers in its tip", () => {
    const item = badge();
    const card = achievementCardView(item, false);
    expect(card.locked).toBe(true);
    expect(card.status).toEqual({ kind: "progress", percent: 40, text: achievementProgress(item) });
    expect(card.tipStatus).toBe(achievementExact(item));
  });

  it("leaves a tier behind another inert: no progress, the numbers in its tip", () => {
    const item = badge();
    const card = achievementCardView(item, true);
    expect(card).toMatchObject({ future: true, status: { kind: "none" } });
    expect(card.tipStatus).toBe(achievementExact(item));
  });
});

describe("achievementSections", () => {
  const ladder = (tiers: UsageAchievement[]): UsageAchievementLadder => ({ metric: "sessions", tiers });

  it("leads with the goals in progress, then the trophies, then the locked tail", () => {
    const sections = achievementSections([
      ladder([
        badge({ id: "sessions-1", threshold: 1, achievedAt: EARNED_AT }),
        badge({ id: "sessions-10" }),
        badge({ id: "sessions-100", threshold: 100 }),
      ]),
    ]);
    expect(sections.map((section) => [section.title, section.cards.map((card) => [card.id, card.future])])).toEqual([
      ["In progress", [["sessions-10", false]]],
      ["Earned", [["sessions-1", false]]],
      ["Locked", [["sessions-100", true]]],
    ]);
  });

  it("leaves out a section with nothing in it", () => {
    const sections = achievementSections([ladder([badge({ id: "sessions-10" })])]);
    expect(sections.map((section) => section.title)).toEqual(["In progress"]);
  });
});

describe("a kept award", () => {
  it("reads as earned, undated, when the ledger no longer crosses it", () => {
    const card = achievementCardView(badge({ earned: true, achievedAt: null }), false);
    expect(card.locked).toBe(false);
    expect(card.status).toEqual({ kind: "earned", text: "earned" });
    expect(card.tipStatus).toBe("Earned");
  });
});
