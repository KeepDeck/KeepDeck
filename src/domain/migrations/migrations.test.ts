import { describe, expect, it } from "vitest";
import {
  DECK_MIN_READER,
  DECK_STATE_VERSION,
  migrateDeck,
  settingsFloorBreach,
  SETTINGS_VERSION,
} from "./migrations";

describe("migrateDeck — revision ladder + compatibility floor", () => {
  it("upgrades a v1 document hop by hop to the current revision", () => {
    const out = migrateDeck({ version: 1, workspaces: [], marker: "kept" });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.doc.version).toBe(DECK_STATE_VERSION);
    expect(out.doc.marker).toBe("kept"); // steps transform, never truncate
  });

  it("the ladder has no holes: every past revision reaches the current one", () => {
    for (let v = 1; v <= DECK_STATE_VERSION; v++) {
      const out = migrateDeck({ version: v });
      expect(out.kind).toBe("ok");
      if (out.kind === "ok") expect(out.doc.version).toBe(DECK_STATE_VERSION);
    }
  });

  it("reads a NEWER revision as-is when its floor admits this build", () => {
    // The forward-compat contract: an additive future is not our problem —
    // the tolerant reader + extras preservation take it from here.
    const doc = { version: DECK_STATE_VERSION + 5, minVersion: 1, future: true };
    const out = migrateDeck(doc);
    expect(out).toEqual({ kind: "ok", doc });
  });

  it("parks a file whose floor is above this build", () => {
    expect(
      migrateDeck({ version: 9, minVersion: DECK_STATE_VERSION + 1 }),
    ).toEqual({ kind: "incompatible", version: 9, minVersion: DECK_STATE_VERSION + 1 });
  });

  it("a newer file WITHOUT a declared floor can only promise itself — parked", () => {
    // Pre-floor writers never emitted minVersion; a future build that
    // stopped writing it gets the conservative treatment.
    const out = migrateDeck({ version: DECK_STATE_VERSION + 1 });
    expect(out.kind).toBe("incompatible");
  });

  it("rejects revisions below the ladder's floor and non-numeric versions", () => {
    expect(migrateDeck({ version: 0 }).kind).toBe("unusable");
    expect(migrateDeck({ version: "1" }).kind).toBe("unusable");
    expect(migrateDeck({}).kind).toBe("unusable");
  });

  it("this build writes a floor no higher than itself", () => {
    // A floor above the writer's own revision would park the writer's own
    // files — a nonsense state the constants must never reach.
    expect(DECK_MIN_READER).toBeLessThanOrEqual(DECK_STATE_VERSION);
  });
});

describe("settingsFloorBreach", () => {
  it("admits anything at or below this build, and unmarked documents", () => {
    expect(settingsFloorBreach({ version: 1 })).toBeNull();
    expect(settingsFloorBreach({ version: 99, minVersion: 1 })).toBeNull();
    expect(settingsFloorBreach({})).toBeNull(); // hand-made file, no markers
  });

  it("reports a floor above this build", () => {
    expect(
      settingsFloorBreach({ version: 99, minVersion: SETTINGS_VERSION + 1 }),
    ).toBe(SETTINGS_VERSION + 1);
  });
});
