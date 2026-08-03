import { describe, expect, it } from "vitest";
import {
  achievementCatalog,
  LADDERS,
  migrateCongratulated,
  RECALIBRATED_IDS,
} from "./catalog";
import {
  achievementRarity,
  atLeastAsRare,
  rarityForDays,
  RARITY_ORDER,
  referenceDays,
  type AchievementRarity,
} from "./rarity";

/** Ladders whose steps are meant to land one per band — the accumulating
 * ones. Coverage and peaks declare their level instead. */
const PACED = ["tokens", "outputTokens", "cacheTokens", "sessions", "spendUsd", "streakDays"];

describe("rarity bands", () => {
  it("puts a duration in the band it belongs to", () => {
    expect(rarityForDays(0.5)).toBe("common");
    expect(rarityForDays(3)).toBe("uncommon");
    expect(rarityForDays(20)).toBe("rare");
    expect(rarityForDays(60)).toBe("epic");
    expect(rarityForDays(400)).toBe("legendary");
  });

  it("closes each band at its edge, so a threshold cannot sit in two", () => {
    expect(rarityForDays(2)).toBe("uncommon");
    expect(rarityForDays(7)).toBe("rare");
    expect(rarityForDays(30)).toBe("epic");
    expect(rarityForDays(90)).toBe("legendary");
  });

  it("has no ceiling: a decade is the same legendary as a year", () => {
    expect(rarityForDays(3650)).toBe("legendary");
  });

  it("orders rarities", () => {
    expect(atLeastAsRare("epic", "rare")).toBe(true);
    expect(atLeastAsRare("rare", "rare")).toBe(true);
    expect(atLeastAsRare("uncommon", "epic")).toBe(false);
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
    expect(referenceDays("streakDays", 45)).toBe(45);
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

  it("mints a unique id per tier", () => {
    const ids = achievementCatalog().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("carrying awards across the recalibration", () => {
  it("maps a moved tier onto the step that replaced it", () => {
    const migrated = migrateCongratulated(["tokens-10000000", "sessions-100"]);
    expect(migrated.has("tokens-25000000")).toBe(true);
    expect(migrated.has("sessions-25")).toBe(true);
    expect(migrated.has("tokens-10000000")).toBe(false);
  });

  it("keeps ids it cannot place — a newer build's set must survive a downgrade", () => {
    expect(migrateCongratulated(["tokens-999"])).toEqual(new Set(["tokens-999"]));
  });

  it("only ever maps onto ids the catalog actually has", () => {
    const known = new Set(achievementCatalog().map((entry) => entry.id));
    for (const [from, to] of RECALIBRATED_IDS) {
      expect(known.has(to), `${from} → ${to}`).toBe(true);
    }
  });

  it("moves a whole shifted ladder one step at a time, without collapsing it", () => {
    // The spend ladder shifted by a rung, so some old ids are ALSO live new
    // ids ($10 was Coffee Money, now it is First Dollar). Mapping each award
    // independently still lands every one on the tier that replaced it —
    // which is exactly why the pass must run only once (see decode()).
    const before = ["spendUsd-1", "spendUsd-10", "spendUsd-100", "spendUsd-1000"];
    expect([...migrateCongratulated(before)].sort()).toEqual([
      "spendUsd-10",
      "spendUsd-100",
      "spendUsd-1500",
      "spendUsd-500",
    ]);
  });

  it("keeps every tier the catalog offers reachable by its own id", () => {
    const live = new Set(achievementCatalog().map((entry) => entry.id));
    for (const ladder of LADDERS) {
      for (const tier of ladder.tiers) {
        expect(live.has(`${ladder.metric}-${tier.threshold}`), tier.title).toBe(true);
      }
    }
  });
});
