import { describe, expect, it } from "vitest";
import {
  achievementCatalog,
  achievementId,
  knownAchievementIds,
  LADDERS,
  RECALIBRATED_IDS_V2,
} from "./catalog";

/** The catalog's own contracts: id minting, and the id pairs a persisted
 * congratulated set is carried across. HOW those pairs are applied, and when,
 * belongs to the notifier, which owns the file format, and is tested there. */

describe("the catalog's ids", () => {
  it("mints an id from the metric and the threshold, and nothing else", () => {
    // A wire format: this exact string sits in achievements.json, so a change
    // of shape un-congratulates every past award. Pinned literally, because a
    // test that rebuilds the template from the same parts proves only that
    // template equals itself.
    expect(achievementId("tokens", 2.5e7)).toBe("tokens-25000000");
    expect(achievementId("spendUsd", 1_500)).toBe("spendUsd-1500");
    // The title is deliberately absent — which is what made renaming the four
    // badges that outgrew their names free, with no migration at all.
    expect(achievementId("sessions", 25)).toBe("sessions-25");
  });

  it("mints a unique id per tier", () => {
    // Two tiers sharing a threshold share an id, and the congratulated set
    // is a Set — so the second could never be announced, for the life of the
    // install. It would also duplicate a React key in the gallery.
    const ids = achievementCatalog().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every tier reachable by its own id", () => {
    const live = new Set(achievementCatalog().map((entry) => entry.id));
    for (const ladder of LADDERS) {
      for (const tier of ladder.tiers) {
        expect(live.has(achievementId(ladder.metric, tier.threshold)), tier.title).toBe(
          true,
        );
      }
    }
  });

  it("counts a retired id among the ones it knows", () => {
    const known = knownAchievementIds();
    // Live…
    expect(known.has("tokens-25000000")).toBe(true);
    // …and retired: the notifier must be able to tell an id this build has
    // heard of from one a NEWER build invented, and a retired tier is the
    // first kind, not the second.
    expect(known.has("tokens-10000000")).toBe(true);
    expect(known.has("some-future-tier")).toBe(false);
  });
});

/**
 * Every id the catalog minted BEFORE the first recalibration, frozen. A
 * migration pair can only be written against a baseline, and once the old
 * ladders left the source there is nowhere else to read one from.
 *
 * A later recalibration freezes its own snapshot beside this one.
 */
const IDS_BEFORE_V2: readonly string[] = [
  "tokens-1000000", "tokens-10000000", "tokens-100000000", "tokens-1000000000",
  "tokens-10000000000", "tokens-100000000000", "tokens-1000000000000",
  "outputTokens-1000000", "outputTokens-10000000", "outputTokens-100000000",
  "outputTokens-1000000000",
  "cacheTokens-100000000", "cacheTokens-1000000000", "cacheTokens-10000000000",
  "sessions-1", "sessions-10", "sessions-100", "sessions-1000", "sessions-10000",
  "spendUsd-1", "spendUsd-10", "spendUsd-100", "spendUsd-1000", "spendUsd-10000",
  "spendUsd-100000",
  "dayTokens-1000000", "dayTokens-10000000", "dayTokens-100000000",
  "dayTokens-1000000000",
  "daySessions-5", "daySessions-15", "daySessions-40",
  "dayProviders-4",
  "sessionTokens-10000000", "sessionTokens-100000000", "sessionTokens-1000000000",
  "sessionTurns-100", "sessionHours-8", "sessionSpendUsd-100",
  "streakDays-3", "streakDays-7", "streakDays-14", "streakDays-30",
  "streakDays-100",
  "providers-2", "providers-3", "providers-4",
  "models-3", "models-10", "models-25",
  "workspaces-2", "workspaces-5", "workspaces-10",
];

describe("the recalibration's id pairs", () => {
  it("leaves no retired id without somewhere to go", () => {
    // THE guard the map exists for. Move a threshold without adding its pair
    // and this fails — which is the only thing standing between the next
    // recalibration and a wall of duplicate congratulations.
    const live = new Set(achievementCatalog().map((entry) => entry.id));
    const orphans = IDS_BEFORE_V2.filter(
      (id) => !live.has(id) && !RECALIBRATED_IDS_V2.has(id),
    );
    expect(orphans).toEqual([]);
  });

  it("only ever maps onto ids the catalog actually has", () => {
    const known = new Set(achievementCatalog().map((entry) => entry.id));
    for (const [from, to] of RECALIBRATED_IDS_V2) {
      expect(known.has(to), `${from} → ${to}`).toBe(true);
    }
  });

  it("never moves an award to a DIFFERENT ladder", () => {
    // A copy-paste that pointed spendUsd-1 at sessions-5 would satisfy the
    // test above and quietly hand the user someone else's trophy.
    for (const [from, to] of RECALIBRATED_IDS_V2) {
      const metric = (id: string) => id.slice(0, id.lastIndexOf("-"));
      expect(metric(to), `${from} → ${to}`).toBe(metric(from));
    }
  });

  it("maps only ids that existed before the recalibration", () => {
    for (const from of RECALIBRATED_IDS_V2.keys()) {
      expect(IDS_BEFORE_V2, from).toContain(from);
    }
  });

  it("still has ids that are both a retired key and a live target", () => {
    // The spend ladder shifted by a whole rung, so $10 is simultaneously the
    // old Coffee Money and the new First Tenner. That overlap is what makes a
    // blind second pass destructive, and it is why the notifier reconciles
    // against the ledger rather than trusting the rewrite.
    const live = new Set(achievementCatalog().map((entry) => entry.id));
    const overlap = [...RECALIBRATED_IDS_V2.keys()].filter((id) => live.has(id));
    expect(overlap.sort()).toEqual(["spendUsd-10", "spendUsd-100"]);
  });
});
