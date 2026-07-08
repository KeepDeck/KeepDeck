import { describe, expect, it } from "vitest";
import { FALLBACK_AGENTS } from "../agents";
import type { DeckState } from "./reducer";
import {
  DECK_STATE_VERSION,
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
  // Dock open on purpose: the round-trip must NOT carry it (session-only).
  viewByWs: { "ws-2": { focus: "pane-3", select: "pane-3", dock: true } },
};

describe("serializeDeck → hydrateDeck round-trip", () => {
  const restored = okDeck(serializeDeck(state));

  it("restores workspaces, view state and the active id", () => {
    expect(restored.state.activeId).toBe("ws-5");
    // Only the durable half (focus/select) comes back; dock is session-only.
    expect(restored.state.viewByWs).toEqual({
      "ws-2": { focus: "pane-3", select: "pane-3" },
    });
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

  it("never persists the dock state — every launch starts closed", () => {
    const json = serializeDeck(state);
    expect(json).not.toContain("dockByWs");
    expect(json).not.toContain("dockTab");
    expect(restored.state.viewByWs["ws-2"].dock).toBeUndefined();
    expect(restored.state.viewByWs["ws-2"].dockTab).toBeUndefined();
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
    // Both focus entries point at unknown ids and vanish; the valid selection
    // remains, so ws-1's view is select-only.
    expect(restored.state.viewByWs).toEqual({ "ws-1": { select: "pane-1" } });
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
    expect(stale.state.viewByWs).toEqual({});
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
    viewByWs: {},
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

describe("workspace plugin slots round-trip", () => {
  const pluginState: DeckState = {
    workspaces: [
      {
        id: "ws-1",
        name: "app",
        cwd: "/repo",
        worktreeBaseDir: null,
        // An arbitrary, deeply nested value — the slot's content is the
        // owning plugin's business, never validated by this layer.
        plugins: {
          git: {
            remote: "origin",
            nested: { branches: ["main", "dev"], count: 2 },
          },
        },
        panes: [{ id: "pane-1" }],
      },
    ],
    activeId: "ws-1",
    viewByWs: {},
  };

  it("persists and restores an arbitrary nested slot value verbatim", () => {
    const restored = okDeck(serializeDeck(pluginState));
    expect(restored.state.workspaces[0].plugins).toEqual(
      pluginState.workspaces[0].plugins,
    );
  });

  it("a workspace without any plugin state stays without the field (sparse)", () => {
    const bare: DeckState = {
      ...pluginState,
      workspaces: [{ ...pluginState.workspaces[0], plugins: undefined }],
    };
    expect(serializeDeck(bare)).not.toContain('"plugins"');
    expect(
      okDeck(serializeDeck(bare)).state.workspaces[0].plugins,
    ).toBeUndefined();
  });

  it("drops a non-object plugins bag while the rest of the workspace survives", () => {
    const doc = JSON.parse(serializeDeck(pluginState));
    doc.workspaces[0].plugins = "not an object";
    const restored = okDeck(JSON.stringify(doc));
    expect(restored.state.workspaces[0].plugins).toBeUndefined();
    expect(restored.state.workspaces[0].panes[0].id).toBe("pane-1");
  });

  it("a v3 deck (pre plugin slots) loads cleanly through the ladder", () => {
    const v3 = {
      version: 3,
      minVersion: 1,
      activeId: "ws-1",
      focusByWs: {},
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
    };
    const restored = okDeck(JSON.stringify(v3));
    expect(restored.state.workspaces[0].plugins).toBeUndefined();
  });
});

describe("deck v5 — Workspace.run retirement", () => {
  const v4WithRun = {
    version: 4,
    minVersion: 1,
    activeId: "ws-1",
    focusByWs: {},
    selectByWs: {},
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
        panes: [{ id: "pane-1" }],
      },
    ],
  };

  it("migrates run.setup onto the workspace and run.presets into the run plugin's slot, dropping run", () => {
    const restored = okDeck(JSON.stringify(v4WithRun));
    const ws = restored.state.workspaces[0];
    expect(ws.setup).toBe("pnpm i");
    expect(ws.plugins).toEqual({
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
    expect("run" in ws).toBe(false);
  });

  it("run stays gone after a save round-trip", () => {
    const restored = okDeck(JSON.stringify(v4WithRun));
    const saved = serializeDeck(restored.state, restored.docExtras);
    expect(saved).not.toContain('"run"');
    const again = okDeck(saved);
    expect(again.state.workspaces[0].setup).toBe("pnpm i");
    expect(again.state.workspaces[0].plugins).toEqual({
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
  });

  it("a v4 doc with only setup migrates setup alone, no plugin slot created", () => {
    const doc = {
      ...v4WithRun,
      workspaces: [
        { ...v4WithRun.workspaces[0], run: { setup: "pnpm i", presets: [] } },
      ],
    };
    const restored = okDeck(JSON.stringify(doc));
    expect(restored.state.workspaces[0].setup).toBe("pnpm i");
    expect(restored.state.workspaces[0].plugins).toBeUndefined();
    expect("run" in restored.state.workspaces[0]).toBe(false);
  });

  it("a v4 doc with only presets migrates the plugin slot alone, no setup set", () => {
    const doc = {
      ...v4WithRun,
      workspaces: [
        {
          ...v4WithRun.workspaces[0],
          run: { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
        },
      ],
    };
    const restored = okDeck(JSON.stringify(doc));
    expect(restored.state.workspaces[0].setup).toBeUndefined();
    expect(restored.state.workspaces[0].plugins).toEqual({
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
  });

  it("a v4 doc without a run object passes through untouched", () => {
    const doc = {
      ...v4WithRun,
      workspaces: [
        {
          id: "ws-1",
          name: "app",
          cwd: "/repo",
          worktreeBaseDir: null,
          panes: [{ id: "pane-1" }],
        },
      ],
    };
    const restored = okDeck(JSON.stringify(doc));
    expect(restored.state.workspaces[0].setup).toBeUndefined();
    expect("run" in restored.state.workspaces[0]).toBe(false);
    expect(restored.state.workspaces[0].plugins).toBeUndefined();
  });

  it("a v2-era doc (pre-plugins) climbs the whole ladder to v5 cleanly", () => {
    const v2 = {
      version: 2,
      activeId: "ws-1",
      focusByWs: {},
      selectByWs: {},
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
          panes: [{ id: "pane-1" }],
        },
      ],
    };
    const restored = okDeck(JSON.stringify(v2));
    expect(restored.state.workspaces[0].setup).toBe("pnpm i");
    expect(restored.state.workspaces[0].plugins).toEqual({
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
    expect("run" in restored.state.workspaces[0]).toBe(false);
  });

  it("setup round-trips through serializeDeck/hydrateDeck", () => {
    const setupState: DeckState = {
      workspaces: [
        {
          id: "ws-1",
          name: "app",
          cwd: "/repo",
          worktreeBaseDir: null,
          setup: "pnpm i",
          panes: [],
        },
      ],
      activeId: "ws-1",
      viewByWs: {},
    };
    const restored = okDeck(serializeDeck(setupState));
    expect(restored.state.workspaces[0].setup).toBe("pnpm i");
  });

  it("a workspace without setup stays without the field (sparse)", () => {
    const bareState: DeckState = {
      workspaces: [
        { id: "ws-1", name: "app", cwd: "/repo", worktreeBaseDir: null, panes: [] },
      ],
      activeId: "ws-1",
      viewByWs: {},
    };
    expect(serializeDeck(bareState)).not.toContain('"setup"');
  });

  it("a malformed setup degrades to absent without dropping the workspace", () => {
    const blank = {
      version: DECK_STATE_VERSION,
      minVersion: 1,
      activeId: "ws-1",
      focusByWs: {},
      selectByWs: {},
      workspaces: [
        {
          id: "ws-1",
          name: "app",
          cwd: "/repo",
          worktreeBaseDir: null,
          setup: "   ",
          panes: [{ id: "pane-1" }],
        },
      ],
    };
    const restoredBlank = okDeck(JSON.stringify(blank));
    expect(restoredBlank.state.workspaces[0].setup).toBeUndefined();
    expect(restoredBlank.state.workspaces[0].panes[0].id).toBe("pane-1");

    const nonString = {
      ...blank,
      workspaces: [{ ...blank.workspaces[0], setup: 42 }],
    };
    const restoredNonString = okDeck(JSON.stringify(nonString));
    expect(restoredNonString.state.workspaces[0].setup).toBeUndefined();
  });

  it("an existing v4 plugins['keepdeck.run'] slot loses to the migrated run.presets", () => {
    const doc = {
      ...v4WithRun,
      workspaces: [
        {
          ...v4WithRun.workspaces[0],
          plugins: {
            "keepdeck.run": { presets: [{ id: "old", name: "Old", command: "old cmd" }] },
            other: { kept: true },
          },
        },
      ],
    };
    const restored = okDeck(JSON.stringify(doc));
    expect(restored.state.workspaces[0].plugins).toEqual({
      other: { kept: true },
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
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
      viewByWs: {},
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
    expect(out.version).toBe(DECK_STATE_VERSION);
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
    expect("run" in restored.state.workspaces[0]).toBe(false);
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
    expect(saved.version).toBe(DECK_STATE_VERSION);
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
