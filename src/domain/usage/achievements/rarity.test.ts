import { describe, expect, it } from "vitest";
import { achievementCatalog } from "./catalog";
import {
  achievementRarity,
  PACED_METRICS,
  RARITY_ORDER,
  type AchievementRarity,
} from "./rarity";

/** Which ladders are meant to land one step per band — READ from the pace
 * table, never re-listed here. A hand-copy would silently stop covering the
 * newest ladder, which is the one most likely to be miscalibrated. */
const PACED: readonly string[] = PACED_METRICS;

/** Rarity as an order, for the monotonicity check below. */
const atLeastAsRare = (left: AchievementRarity, right: AchievementRarity) =>
  RARITY_ORDER.indexOf(left) >= RARITY_ORDER.indexOf(right);

/** The bands are stated in DAYS, and the only way in is a threshold — so a
 * band test picks a metric whose pace is one unit a day and reads the
 * threshold as days directly. `streakDays` is that metric by definition. */
const forDays = (days: number) => achievementRarity("streakDays", days);

describe("rarity bands", () => {
  it("puts a duration in the band it belongs to", () => {
    expect(forDays(0.5)).toBe("common");
    expect(forDays(3)).toBe("uncommon");
    expect(forDays(20)).toBe("rare");
    expect(forDays(60)).toBe("epic");
    expect(forDays(400)).toBe("legendary");
  });

  it("closes each band at its edge, so a threshold cannot sit in two", () => {
    expect(forDays(2)).toBe("uncommon");
    expect(forDays(7)).toBe("rare");
    expect(forDays(30)).toBe("epic");
    expect(forDays(90)).toBe("legendary");
  });

  it("has no ceiling: a decade is the same legendary as a year", () => {
    expect(forDays(3650)).toBe("legendary");
  });

  it("names the levels in ascending order", () => {
    // RARITY_ORDER is production data — the dress, the labels and the
    // monotonicity check below all read the sequence from it.
    expect(RARITY_ORDER).toEqual([
      "common",
      "uncommon",
      "rare",
      "epic",
      "legendary",
    ]);
  });
});

describe("achievementRarity", () => {
  it("derives an accumulating tier from the reference pace", () => {
    // A million tokens is hours of work; two billion is most of a year.
    expect(achievementRarity("tokens", 1e6)).toBe("common");
    expect(achievementRarity("tokens", 2e9)).toBe("legendary");
  });

  it("lets a declared level win, because coverage is not a duration", () => {
    expect(achievementRarity("providers", 4, "rare")).toBe("rare");
  });

  it("refuses to guess when a metric has neither pace nor declared level", () => {
    // Silently answering "common" here would dress a legendary badge as a
    // starter one, and nothing would ever point at the catalog.
    expect(() => achievementRarity("dayProviders", 4)).toThrow(/dayProviders/);
  });

  it("measures a calendar streak in days, not in work", () => {
    // A day is a day at any intensity, so the streak ladder's thresholds ARE
    // its durations — which is what makes it the yardstick above.
    expect(achievementRarity("streakDays", 45)).toBe("epic");
    expect(achievementRarity("streakDays", 90)).toBe("legendary");
  });

  it("refuses a metric the pace table has never heard of", () => {
    // The table is total over the metric union, so this needs a cast to
    // reach — but `referenceDays` used to answer NaN here, and NaN loses
    // every band comparison, so the tier arrived dressed as LEGENDARY.
    expect(() =>
      achievementRarity("agents" as Parameters<typeof achievementRarity>[0], 5),
    ).toThrow(/agents/);
  });
});

describe("the catalog holds to the rule", () => {
  it("gives every tier a rarity", () => {
    for (const entry of achievementCatalog()) {
      expect(RARITY_ORDER).toContain(entry.rarity);
    }
  });

  it("never lets a ladder's rarity go backwards as thresholds rise", () => {
    for (const ladder of achievementCatalog().reduce((byMetric, entry) => {
      const tiers = byMetric.get(entry.metric) ?? [];
      tiers.push(entry.rarity);
      byMetric.set(entry.metric, tiers);
      return byMetric;
    }, new Map<string, AchievementRarity[]>())) {
      const [metric, rarities] = ladder;
      for (let i = 1; i < rarities.length; i += 1) {
        expect(
          atLeastAsRare(rarities[i], rarities[i - 1]),
          `${metric}: ${rarities[i - 1]} → ${rarities[i]}`,
        ).toBe(true);
      }
    }
  });

  it("walks every band exactly once on the accumulating ladders", () => {
    // This is the calibration contract: five steps, five levels, in order.
    // Nudging a threshold without moving its band breaks the build here.
    for (const metric of PACED) {
      const tiers = achievementCatalog().filter((entry) => entry.metric === metric);
      const firstFive = tiers.slice(0, 5).map((tier) => tier.rarity);
      expect(firstFive, metric).toEqual(RARITY_ORDER);
    }
  });

  it("keeps re-earned tops legendary, and marks which time they are", () => {
    const repeats = achievementCatalog().filter((entry) => entry.repeat !== undefined);
    expect(repeats.length).toBeGreaterThan(0);
    for (const entry of repeats) {
      expect(entry.rarity, entry.id).toBe("legendary");
      expect(entry.repeat).toBeGreaterThan(1);
    }
  });

  it("ends the provider ladder where the world does", () => {
    // Only four providers exist; a legendary step would be unreachable by
    // construction rather than by effort.
    const providers = achievementCatalog().filter((e) => e.metric === "providers");
    expect(providers.map((tier) => tier.rarity)).toEqual([
      "common",
      "uncommon",
      "rare",
    ]);
  });

});

