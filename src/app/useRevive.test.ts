// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckState } from "../domain/deck";
import { EMPTY_SPAWN_CONTEXT } from "../domain/agents";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import {
  buildResumeSpec,
  peekPaneSpawnSpec,
  resetPaneSpawnSpecs,
} from "./spawnSpecs";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { useRevive, type ReviveApi } from "./useRevive";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ipc = vi.hoisted(() => ({
  probeWorktree: vi.fn(),
}));
vi.mock("../ipc/worktree", () => ({ probeWorktree: ipc.probeWorktree }));

// Resume plans are built through the agent plugins' hooks; the seam is
// mocked with a tiny cache so these tests assert revive POLICY (when a
// resume plan is requested) — the plan CONTENT is the plugin tests' job.
vi.mock("./spawnSpecs", () => {
  const specs = new Map<string, unknown>();
  return {
    buildResumeSpec: vi.fn(
      async (
        _plugins: unknown,
        _agentType: string,
        facts: { paneId: string },
        _ctx: unknown,
        resumeId: string,
        _origin: "restore" | "manual",
      ) => {
        specs.set(facts.paneId, { args: ["--resume", resumeId], env: [] });
        return true;
      },
    ),
    peekPaneSpawnSpec: (id: string) =>
      specs.get(id) as { args: string[] } | undefined,
    resetPaneSpawnSpecs: () => specs.clear(),
    worktreeRootsOf: () => [],
  };
});
vi.mock("./runtimeContext", () => ({
  useAppRuntime: () => ({ plugins: {} }),
}));

let deck: Deck;
let revive: ReviveApi;
const ctx = { ...EMPTY_SPAWN_CONTEXT, bridgeDir: "/bridge/run-1" };

// The catalog the revive gate consults — swappable per test (the id set is
// open: revive must skip panes whose agent no plugin provides).
const catalog = {
  agents: ["claude", "codex", "opencode"].map((id) => ({
    id,
    label: id,
    command: id,
    supportsYolo: false,
    installed: true,
    path: null,
  })),
  ready: true,
};

function Probe() {
  deck = useDeck();
  revive = useRevive(deck, catalog.agents, ctx, catalog.ready);
  return null;
}

/** A deck with one dormant claude pane; `pane` overrides fields. */
const restored = (pane: object): DeckState => ({
  workspaces: [
    {
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [{ id: "pane-1", agentType: "claude", dormant: true, ...pane }],
    },
  ],
  activeId: "ws-1",
  viewByWs: {},
});

/** Let the probe→validate→revive promise chain settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};

describe("useRevive — session policy", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const pane = () => deck.workspaces[0].panes[0];

  it("a recorded binding is TRUSTED and resumed — no store is read", async () => {
    // The binding came from the pane's own process (the reporter posts at
    // session creation), so it existed; a session deleted since fails the
    // resume VISIBLY in the terminal — accepted, rare, uniform. The app
    // never opens an agent's session store.
    act(() => deck.hydrate(restored({ session: { id: "old", boundAt: "t" } })));
    await settle();

    expect(pane().dormant).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "old"]);
    expect(pane().session).toEqual({ id: "old", boundAt: "t" }); // kept
    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      {
        paneId: "pane-1",
        workspace: {
          id: "ws-1",
          instance: deck.workspaces[0].instance,
        },
        cwd: "/repo",
        branch: undefined,
        yolo: undefined,
        wsWorktreeRoots: [],
      },
      expect.anything(),
      "old",
      "restore",
    );
  });

  it("an unbound pane starts FRESH — never matched by directory", async () => {
    // Every agent reports its id post-hoc now, so an unbound pane is normal
    // (never messaged, a mid-TUI /new, or a reporter that couldn't arm).
    // Matching the newest session in the pane's cwd would resume a FOREIGN
    // conversation whenever panes share a cwd (the default — a worktree is
    // optional): unbound wakes fresh, with no resume spec.
    act(() => deck.hydrate(restored({ agentType: "codex", cwd: "/repo" })));
    await settle();

    expect(pane().dormant).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined(); // fresh spawn plan
  });

  it("an agent no plugin provides stays dormant — and KEEPS its binding", async () => {
    // Waking would spawn the bare id as a command; the binding may resume
    // perfectly once the plugin is re-enabled. No wake, no probe.
    act(() =>
      deck.hydrate(
        restored({ agentType: "gemini", session: { id: "old", boundAt: "t" } }),
      ),
    );
    await settle();

    expect(pane().dormant).toBe(true);
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
    expect(pane().session).toEqual({ id: "old", boundAt: "t" });
  });

  it("nothing wakes before the catalog is ready", async () => {
    // Before plugin bootstrap EVERY id is absent from the catalog — waking
    // then would misjudge every pane. The effect waits for the ready flag.
    catalog.ready = false;
    act(() => root.render(createElement(Probe)));
    act(() => deck.hydrate(restored({})));
    await settle();

    expect(pane().dormant).toBe(true);
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });

  it("a gone directory blocks revival instead of spawning into nowhere", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(restored({ cwd: "/repo/wt-gone" })));
    await settle();

    expect(pane().dormant).toBe(true);
    expect(revive.blocked["pane-1"]).toBe("/repo/wt-gone");
  });

  it("closing a blocked pane reaps its blocked entry", async () => {
    // Pane ids are never reused, so entries left behind by closed panes
    // would accumulate for the whole session.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(restored({ cwd: "/repo/wt-gone" })));
    await settle();
    expect(revive.blocked["pane-1"]).toBe("/repo/wt-gone");

    act(() => deck.closeAgent("ws-1", "pane-1"));
    await settle();
    expect(revive.blocked).toEqual({});
  });
});
