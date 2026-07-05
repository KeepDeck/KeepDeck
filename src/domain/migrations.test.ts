import { describe, expect, it } from "vitest";
import { DECK_STATE_VERSION, migrateDeck } from "./migrations";

describe("migrateDeck — the revision ladder", () => {
  it("upgrades a v1 document hop by hop to the current revision", () => {
    const v1 = { version: 1, workspaces: [], marker: "kept" };
    const out = migrateDeck(v1)!;
    expect(out.version).toBe(DECK_STATE_VERSION);
    expect(out.marker).toBe("kept"); // steps transform, never truncate
  });

  it("a document already at the current revision passes through", () => {
    const doc = { version: DECK_STATE_VERSION, workspaces: [] };
    expect(migrateDeck(doc)?.version).toBe(DECK_STATE_VERSION);
  });

  it("rejects a NEWER revision — quarantine beats misreading a future shape", () => {
    expect(migrateDeck({ version: DECK_STATE_VERSION + 1 })).toBeNull();
  });

  it("rejects revisions below the ladder's floor and non-numeric versions", () => {
    expect(migrateDeck({ version: 0 })).toBeNull();
    expect(migrateDeck({ version: "1" })).toBeNull();
    expect(migrateDeck({})).toBeNull();
  });

  it("the ladder has no holes: every past revision reaches the current one", () => {
    for (let v = 1; v <= DECK_STATE_VERSION; v++) {
      expect(migrateDeck({ version: v })?.version).toBe(DECK_STATE_VERSION);
    }
  });
});
