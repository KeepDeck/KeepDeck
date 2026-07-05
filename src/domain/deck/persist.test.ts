import { describe, expect, it } from "vitest";
import { FALLBACK_AGENTS } from "../agents";
import type { DeckState } from "./reducer";
import {
  PROVISIONING_INTERRUPTED,
  hydrateDeck,
  serializeDeck,
  type HydratedDeck,
} from "./persist";

/** Unwrap an expected-ok hydration; fails the test loudly otherwise. */
function okDeck(json: string): HydratedDeck {
  const result = hydrateDeck(json);
  if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
  return result.deck;
}

const state: DeckState = {
  workspaces: [
    {
      id: "ws-2",
      name: "KeepDeck",
      cwd: "/repo",
      worktreeBaseDir: "/repo/.wt",
      panes: [
        {
          id: "pane-3",
          agentType: "claude",
          cwd: "/repo/wt-3",
          branch: "kd/ws/3",
          autoTitle: "fixing auth",
          session: { id: "abc-123", boundAt: "2026-07-02T00:00:00Z" },
        },
        { id: "pane-7", agentType: "codex" },
      ],
    },
    {
      id: "ws-5",
      name: "Site",
      cwd: "/site",
      worktreeBaseDir: null,
      panes: [],
    },
  ],
  activeId: "ws-5",
  focusByWs: { "ws-2": "pane-3" },
  selectByWs: { "ws-2": "pane-3" },
};

describe("serializeDeck → hydrateDeck round-trip", () => {
  const restored = okDeck(serializeDeck(state));

  it("restores workspaces, selection maps and the active id", () => {
    expect(restored.state.activeId).toBe("ws-5");
    expect(restored.state.focusByWs).toEqual({ "ws-2": "pane-3" });
    expect(restored.state.selectByWs).toEqual({ "ws-2": "pane-3" });
    expect(restored.state.workspaces.map((w) => w.id)).toEqual(["ws-2", "ws-5"]);
    const pane = restored.state.workspaces[0].panes[0];
    expect(pane.cwd).toBe("/repo/wt-3");
    expect(pane.branch).toBe("kd/ws/3");
    expect(pane.autoTitle).toBe("fixing auth");
    expect(pane.session).toEqual({ id: "abc-123", boundAt: "2026-07-02T00:00:00Z" });
  });

  it("marks every restored pane dormant", () => {
    for (const ws of restored.state.workspaces) {
      for (const pane of ws.panes) expect(pane.dormant).toBe(true);
    }
  });

  it("derives the id-mint seeds from the highest persisted ids", () => {
    expect(restored.nextAgentSeq).toBe(8); // pane-7 + 1
    expect(restored.nextWorkspaceSeq).toBe(6); // ws-5 + 1
  });

  it("does not persist the runtime dormant flag", () => {
    const dormantState: DeckState = {
      ...state,
      workspaces: [
        {
          ...state.workspaces[0],
          panes: state.workspaces[0].panes.map((p) => ({ ...p, dormant: true })),
        },
      ],
    };
    expect(serializeDeck(dormantState)).not.toContain("dormant");
  });
});

describe("hydrateDeck — unusable input", () => {
  it("rejects non-JSON, wrong versions and malformed shapes", () => {
    expect(hydrateDeck("not json").kind).toBe("corrupt");
    // No usable floor declared and no numeric... a bare version 99 declares
    // floor 99 → parked, not corrupted.
    expect(
      hydrateDeck(JSON.stringify({ version: 99, workspaces: [] })).kind,
    ).toBe("incompatible");
    expect(hydrateDeck(JSON.stringify({ version: 1 })).kind).toBe("corrupt");
    // A workspace without a cwd is unusable — quarantine the whole file.
    expect(
      hydrateDeck(
        JSON.stringify({
          version: 1,
          activeId: "",
          focusByWs: {},
          selectByWs: {},
          workspaces: [{ id: "ws-1", name: "x", panes: [] }],
        }),
      ).kind,
    ).toBe("corrupt");
  });

  it("rejects a workspace with more panes than the grid can render", () => {
    // paneGrid throws past MAX_PANES and there is no error boundary: a
    // hand-edited oversized deck would otherwise blank the app on EVERY
    // launch. Unusable → quarantine, like any malformed shape.
    const panes = Array.from({ length: 17 }, (_, i) => ({ id: `pane-${i + 1}` }));
    expect(
      hydrateDeck(
        JSON.stringify({
          version: 1,
          activeId: "ws-1",
          focusByWs: {},
          selectByWs: {},
          workspaces: [
            { id: "ws-1", name: "x", cwd: "/x", worktreeBaseDir: null, panes },
          ],
        }),
      ).kind,
    ).toBe("corrupt");
  });

  it("restores a pane of EVERY cataloged agent type", () => {
    // AGENT_TYPES is derived from the TS catalog: a 4th agent added there is
    // restorable automatically, with no separate hand-kept id list to forget
    // (forgetting silently degraded restored panes to the default agent).
    for (const agent of FALLBACK_AGENTS) {
      const restored = okDeck(
        JSON.stringify({
          version: 1,
          activeId: "ws-1",
          focusByWs: {},
          selectByWs: {},
          workspaces: [
            {
              id: "ws-1",
              name: "x",
              cwd: "/x",
              worktreeBaseDir: null,
              panes: [{ id: "pane-1", agentType: agent.id }],
            },
          ],
        }),
      );
      expect(restored.state.workspaces[0].panes[0].agentType).toBe(agent.id);
    }
  });
});

describe("hydrateDeck — tolerated degradations", () => {
  const json = JSON.stringify({
    version: 1,
    activeId: "ws-gone",
    focusByWs: { "ws-1": "pane-gone", "ws-gone": "pane-1" },
    selectByWs: { "ws-1": "pane-1" },
    workspaces: [
      {
        id: "ws-1",
        name: "x",
        cwd: "/x",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "some-future-agent" }],
      },
    ],
  });
  const restored = okDeck(json);

  it("resolves a stale activeId to an existing workspace", () => {
    expect(restored.state.activeId).toBe("ws-1");
  });

  it("drops focus/selection entries pointing at unknown ids", () => {
    expect(restored.state.focusByWs).toEqual({});
    expect(restored.state.selectByWs).toEqual({ "ws-1": "pane-1" });
  });

  it("degrades an unknown agentType to the default instead of rejecting", () => {
    expect(restored.state.workspaces[0].panes[0].agentType).toBeUndefined();
  });

  it("drops a persisted maximize that no longer resolves (solo workspace)", () => {
    // Decks written before the closeAgent fix can carry a focus key on a
    // solo workspace; restoring it verbatim would maximize the wrong pane
    // as soon as a second pane is added.
    const stale = okDeck(
      JSON.stringify({
        version: 1,
        activeId: "ws-1",
        focusByWs: { "ws-1": "pane-1" },
        selectByWs: {},
        workspaces: [
          {
            id: "ws-1",
            name: "x",
            cwd: "/x",
            worktreeBaseDir: null,
            panes: [{ id: "pane-1" }],
          },
        ],
      }),
    );
    expect(stale.state.focusByWs).toEqual({});
  });

  it("seeds mints at 1 when no ids match the minted format", () => {
    const custom = okDeck(
      JSON.stringify({
        version: 1,
        activeId: "",
        focusByWs: {},
        selectByWs: {},
        workspaces: [
          { id: "imported", name: "x", cwd: "/x", worktreeBaseDir: null, panes: [] },
        ],
      }),
    );
    expect(custom.nextAgentSeq).toBe(1);
    expect(custom.nextWorkspaceSeq).toBe(1);
  });
});

describe("provisioning panes across a restart", () => {
  const provisioningState: DeckState = {
    workspaces: [
      {
        id: "ws-1",
        name: "deck",
        cwd: "/repo",
        worktreeBaseDir: "/wt",
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            provisioning: {
              repo: "/repo",
              baseDir: "/wt",
              workspace: "deck",
              index: 1,
              error: "fatal: mid-create failure",
            },
          },
        ],
      },
    ],
    activeId: "ws-1",
    focusByWs: {},
    selectByWs: {},
  };

  it("persists the intent, never the runtime error, and restores an interrupted failed card", () => {
    const json = serializeDeck(provisioningState);
    expect(json).not.toContain("mid-create failure");
    const pane = okDeck(json).state.workspaces[0].panes[0];
    expect(pane.provisioning).toEqual({
      repo: "/repo",
      baseDir: "/wt",
      workspace: "deck",
      index: 1,
      error: PROVISIONING_INTERRUPTED,
    });
    // NOT dormant: the revive flow must leave it alone — there may be no
    // directory to spawn a terminal into.
    expect(pane.dormant).toBeUndefined();
  });

  it("degrades a malformed intent to a plain dormant pane instead of rejecting the deck", () => {
    const doc = JSON.parse(serializeDeck(provisioningState));
    doc.workspaces[0].panes[0].provisioning = { repo: 42 };
    const pane = okDeck(JSON.stringify(doc)).state.workspaces[0].panes[0];
    expect(pane.provisioning).toBeUndefined();
    expect(pane.dormant).toBe(true);
  });
});

describe("run presets round-trip", () => {
  const runState: DeckState = {
    workspaces: [
      {
        id: "ws-1",
        name: "app",
        cwd: "/repo",
        worktreeBaseDir: null,
        run: {
          setup: "pnpm i",
          presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }],
        },
        panes: [{ id: "pane-1", cwd: "/repo/wt-1", branch: "kd/app/1" }],
      },
    ],
    activeId: "ws-1",
    focusByWs: {},
    selectByWs: {},
  };

  it("persists and restores the workspace config", () => {
    // Flag-agnostic by design: a deck saved with the experiment on must
    // survive a load-and-save with it off, so hydration always parses run.
    const restored = okDeck(serializeDeck(runState));
    expect(restored.state.workspaces[0].run).toEqual(runState.workspaces[0].run);
  });

  it("a workspace without run config stays without one (sparse)", () => {
    const bare: DeckState = {
      ...runState,
      workspaces: [{ ...runState.workspaces[0], run: undefined, panes: [] }],
    };
    expect(serializeDeck(bare)).not.toContain('"run"');
    expect(okDeck(serializeDeck(bare)).state.workspaces[0].run).toBeUndefined();
  });

  it("degrades a malformed run value without rejecting the deck", () => {
    const doc = JSON.parse(serializeDeck(runState));
    doc.workspaces[0].run = { presets: "not a list" };
    const restored = okDeck(JSON.stringify(doc));
    expect(restored.state.workspaces[0].run).toBeUndefined();
  });
});

describe("provisioning phase is runtime-only", () => {
  it("a mid-setup deck serializes without the phase", () => {
    const state: DeckState = {
      workspaces: [
        {
          id: "ws-1",
          name: "a",
          cwd: "/repo",
          worktreeBaseDir: "/wt",
          panes: [
            {
              id: "pane-1",
              provisioning: {
                repo: "/repo",
                workspace: "a",
                index: 1,
                phase: "setup",
              },
            },
          ],
        },
      ],
      activeId: "ws-1",
      focusByWs: {},
      selectByWs: {},
    };
    const json = serializeDeck(state);
    expect(json).not.toContain("setup");
    // Restored as the interrupted failed card, like any in-flight create.
    const pane = okDeck(json).state.workspaces[0].panes[0];
    expect(pane.provisioning?.phase).toBeUndefined();
    expect(pane.provisioning?.error).toBe(PROVISIONING_INTERRUPTED);
  });
});

describe("schema revisions and the compatibility floor", () => {
  it("writes the current revision and its floor", () => {
    const out = JSON.parse(serializeDeck(state));
    expect(out.version).toBe(3);
    expect(out.minVersion).toBe(1);
  });

  it("a v1 deck (pre run presets) migrates up on load", () => {
    const v1 = {
      version: 1,
      activeId: "ws-1",
      focusByWs: {},
      selectByWs: {},
      workspaces: [
        {
          id: "ws-1",
          name: "x",
          cwd: "/x",
          worktreeBaseDir: null,
          panes: [{ id: "pane-1", agentType: "claude" }],
        },
      ],
    };
    const restored = okDeck(JSON.stringify(v1));
    expect(restored.state.workspaces[0].panes[0].dormant).toBe(true);
    expect(restored.state.workspaces[0].run).toBeUndefined();
  });

  it("round-trips a NEWER revision's unknown fields at every level", () => {
    const future = {
      version: 9,
      minVersion: 1,
      activeId: "ws-1",
      focusByWs: {},
      selectByWs: {},
      futureDocField: [1, 2],
      workspaces: [
        {
          id: "ws-1",
          name: "x",
          cwd: "/x",
          worktreeBaseDir: null,
          futureWsField: { a: 1 },
          panes: [{ id: "pane-1", futurePaneField: "keep me" }],
        },
      ],
    };
    const restored = okDeck(JSON.stringify(future));
    const saved = JSON.parse(
      serializeDeck(restored.state, restored.docExtras),
    );
    // Saved by THIS build (its revision), with the future's fields intact.
    expect(saved.version).toBe(3);
    expect(saved.futureDocField).toEqual([1, 2]);
    expect(saved.workspaces[0].futureWsField).toEqual({ a: 1 });
    expect(saved.workspaces[0].panes[0].futurePaneField).toBe("keep me");
  });

  it("parks (not corrupts) a deck whose floor is above this build", () => {
    const result = hydrateDeck(
      JSON.stringify({
        version: 9,
        minVersion: 9,
        activeId: "",
        focusByWs: {},
        selectByWs: {},
        workspaces: [],
      }),
    );
    expect(result).toEqual({ kind: "incompatible", version: 9, minVersion: 9 });
  });

  it("a missing or non-numeric version is corrupt", () => {
    expect(
      hydrateDeck(
        JSON.stringify({ activeId: "", focusByWs: {}, selectByWs: {}, workspaces: [] }),
      ).kind,
    ).toBe("corrupt");
    expect(
      hydrateDeck(
        JSON.stringify({ version: "1", activeId: "", focusByWs: {}, selectByWs: {}, workspaces: [] }),
      ).kind,
    ).toBe("corrupt");
  });
});
