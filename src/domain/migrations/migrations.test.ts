import { describe, expect, it } from "vitest";
import {
  DECK_MIN_READER,
  DECK_STATE_VERSION,
  migrateDeck,
  settingsFloorBreach,
  SETTINGS_VERSION,
} from "./migrations";

describe("migrateDeck — revision ladder + compatibility floor", () => {
  it("the deck + settings revisions are the expected values", () => {
    // Pin the bumps so a forgotten version bump (the r3 SETTINGS miss) fails
    // loudly rather than silently shrinking the ladder-loop's coverage.
    expect(DECK_STATE_VERSION).toBe(8);
    expect(SETTINGS_VERSION).toBe(11);
  });

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

describe("migrateDeck — v4 → v5: Workspace.run retirement", () => {
  it("moves run.setup and run.presets to Workspace.setup and the run plugin's slot, dropping run", () => {
    const out = migrateDeck({
      version: 4,
      workspaces: [
        {
          id: "ws-1",
          run: {
            setup: "pnpm i",
            presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }],
          },
        },
      ],
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const ws = (out.doc.workspaces as Record<string, unknown>[])[0];
    expect(ws.setup).toBe("pnpm i");
    expect(ws.plugins).toEqual({
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
    expect(ws.run).toBeUndefined();
  });

  it("moves only setup when presets are empty, still dropping run", () => {
    const out = migrateDeck({
      version: 4,
      workspaces: [{ id: "ws-1", run: { setup: "pnpm i", presets: [] } }],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    const ws = (out.doc.workspaces as Record<string, unknown>[])[0];
    expect(ws.setup).toBe("pnpm i");
    expect(ws.plugins).toBeUndefined();
    expect(ws.run).toBeUndefined();
  });

  it("moves only presets when setup is absent, still dropping run", () => {
    const out = migrateDeck({
      version: 4,
      workspaces: [
        {
          id: "ws-1",
          run: { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
        },
      ],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    const ws = (out.doc.workspaces as Record<string, unknown>[])[0];
    expect(ws.setup).toBeUndefined();
    expect(ws.plugins).toEqual({
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
    expect(ws.run).toBeUndefined();
  });

  it("leaves a workspace without a run object untouched", () => {
    const out = migrateDeck({
      version: 4,
      workspaces: [{ id: "ws-1", name: "x" }],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.doc.workspaces).toEqual([{ id: "ws-1", name: "x" }]);
  });

  it("overwrites a pre-existing keepdeck.run plugin slot with the migrated presets", () => {
    const out = migrateDeck({
      version: 4,
      workspaces: [
        {
          id: "ws-1",
          plugins: {
            "keepdeck.run": { presets: [{ id: "old", name: "Old", command: "old cmd" }] },
            other: { kept: true },
          },
          run: { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
        },
      ],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    const ws = (out.doc.workspaces as Record<string, unknown>[])[0];
    expect(ws.plugins).toEqual({
      other: { kept: true },
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
  });

  it("a v2-era document (pre-plugins) climbs the whole ladder to v5, migrating run along the way", () => {
    const out = migrateDeck({
      version: 2,
      workspaces: [
        {
          id: "ws-1",
          run: {
            setup: "pnpm i",
            presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }],
          },
        },
      ],
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.doc.version).toBe(DECK_STATE_VERSION);
    const ws = (out.doc.workspaces as Record<string, unknown>[])[0];
    expect(ws.setup).toBe("pnpm i");
    expect(ws.plugins).toEqual({
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
    expect(ws.run).toBeUndefined();
  });
});

describe("settingsFloorBreach", () => {
  it("admits anything at or below this build, and unmarked documents", () => {
    expect(settingsFloorBreach({ version: 1 })).toBeNull();
    expect(settingsFloorBreach({ version: 99, minVersion: 1 })).toBeNull();
    expect(settingsFloorBreach({})).toBeNull(); // hand-made file, no markers
  });

  it("admits a bare high version with no declared floor (reads tolerantly)", () => {
    // A hand-edited `version` bump must not nuke every setting to defaults —
    // only an explicit minVersion above this build shuts us out.
    expect(settingsFloorBreach({ version: 99, scrollback: 42 })).toBeNull();
  });

  it("reports a floor above this build", () => {
    expect(
      settingsFloorBreach({ version: 99, minVersion: SETTINGS_VERSION + 1 }),
    ).toBe(SETTINGS_VERSION + 1);
  });
});
