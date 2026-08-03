import { describe, expect, it } from "vitest";
import {
  achievementCatalog,
  LADDERS,
  RECALIBRATED_IDS,
  remapCongratulated,
} from "./catalog";

/** The catalog's own contracts: id minting, and the id pairs a persisted
 * congratulated set is carried across. WHEN those pairs are applied belongs
 * to the notifier, which owns the file format, and is tested there. */

describe("the catalog's ids", () => {
  it("mints a unique id per tier", () => {
    const ids = achievementCatalog().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every tier reachable by its own id", () => {
    const live = new Set(achievementCatalog().map((entry) => entry.id));
    for (const ladder of LADDERS) {
      for (const tier of ladder.tiers) {
        expect(live.has(`${ladder.metric}-${tier.threshold}`), tier.title).toBe(
          true,
        );
      }
    }
  });
});

describe("the recalibration's id pairs", () => {
  it("only ever maps onto ids the catalog actually has", () => {
    const known = new Set(achievementCatalog().map((entry) => entry.id));
    for (const [from, to] of RECALIBRATED_IDS) {
      expect(known.has(to), `${from} → ${to}`).toBe(true);
    }
  });

  it("never moves an award to a DIFFERENT ladder", () => {
    // A copy-paste that pointed spendUsd-1 at sessions-5 would satisfy the
    // test above and quietly hand the user someone else's trophy.
    for (const [from, to] of RECALIBRATED_IDS) {
      const metric = (id: string) => id.slice(0, id.lastIndexOf("-"));
      expect(metric(to), `${from} → ${to}`).toBe(metric(from));
    }
  });

  it("maps a moved tier onto the step that replaced it", () => {
    const moved = remapCongratulated(
      ["tokens-10000000", "sessions-100"],
      RECALIBRATED_IDS,
    );
    expect(moved.has("tokens-25000000")).toBe(true);
    expect(moved.has("sessions-25")).toBe(true);
    expect(moved.has("tokens-10000000")).toBe(false);
  });

  it("keeps ids it cannot place — a newer build's set must survive a downgrade", () => {
    expect(remapCongratulated(["tokens-999"], RECALIBRATED_IDS)).toEqual(
      new Set(["tokens-999"]),
    );
  });

  it("moves a whole shifted ladder one step at a time, without collapsing it", () => {
    // The spend ladder shifted by a rung, so some old ids are ALSO live new
    // ids ($10 was Coffee Money, now it is First Dollar). Mapping each award
    // independently still lands every one on the tier that replaced it —
    // and is exactly why a second pass would be destructive, which is the
    // notifier's job to prevent.
    const before = ["spendUsd-1", "spendUsd-10", "spendUsd-100", "spendUsd-1000"];
    expect([...remapCongratulated(before, RECALIBRATED_IDS)].sort()).toEqual([
      "spendUsd-10",
      "spendUsd-100",
      "spendUsd-1500",
      "spendUsd-500",
    ]);
  });
});
