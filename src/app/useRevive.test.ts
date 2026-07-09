// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckState } from "../domain/deck";
import { EMPTY_SPAWN_CONTEXT } from "../domain/agents";
import { peekPaneSpawnSpec, resetPaneSpawnSpecs } from "./spawnSpecs";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { useRevive, type ReviveApi } from "./useRevive";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ipc = vi.hoisted(() => ({
  probeWorktree: vi.fn(),
  sessionPresence: vi.fn(),
}));
vi.mock("../ipc/worktree", () => ({ probeWorktree: ipc.probeWorktree }));
vi.mock("../ipc/history", () => ({
  sessionPresence: ipc.sessionPresence,
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
    ipc.sessionPresence.mockReset();
    catalog.ready = true;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const pane = () => deck.workspaces[0].panes[0];

  it("a recorded session that's still PRESENT is resumed", async () => {
    ipc.sessionPresence.mockResolvedValue("present");
    act(() => deck.hydrate(restored({ session: { id: "old", boundAt: "t" } })));
    await settle();

    expect(pane().dormant).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "old"]);
  });

  it("a recorded session that's ABSENT starts fresh — NEVER someone else's", async () => {
    // The empty-claude-pane bug: an assigned id nobody spoke to never
    // materialized; falling back to newest-in-directory resurrected an
    // unrelated old conversation.
    ipc.sessionPresence.mockResolvedValue("absent");
    act(() => deck.hydrate(restored({ session: { id: "ghost", boundAt: "t" } })));
    await settle();

    expect(pane().dormant).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined(); // fresh spawn plan
    // The dead binding is DROPPED — otherwise the fresh spawn's identity can
    // never be recorded (the binding hook refuses to overwrite an existing
    // session) and the pane keeps resurrecting fresh forever.
    expect(pane().session).toBeUndefined();
  });

  it("an UNANSWERABLE store keeps the binding and still resumes", async () => {
    // A locked/unreadable store is NOT absence: wiping the binding here
    // loses a conversation `--resume` would still open. Worst case the
    // resume exits visibly in the terminal.
    ipc.sessionPresence.mockResolvedValue("unknown");
    act(() => deck.hydrate(restored({ session: { id: "old", boundAt: "t" } })));
    await settle();

    expect(pane().dormant).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "old"]);
    expect(pane().session).toEqual({ id: "old", boundAt: "t" }); // kept
  });

  it("an unbound codex pane starts FRESH — hooks-only, never matched by directory", async () => {
    // codex/opencode report their id post-hoc, so an unbound pane is normal
    // (never messaged — the session is created lazily with the first message —
    // a mid-TUI /new, or a reporter that couldn't arm). Matching the newest
    // session in the pane's cwd would resume a FOREIGN conversation whenever
    // panes share a cwd (the default — a worktree is optional). Hooks-only:
    // unbound wakes fresh, with no resume spec and without touching any store.
    act(() => deck.hydrate(restored({ agentType: "codex", cwd: "/repo" })));
    await settle();

    expect(pane().dormant).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined(); // fresh spawn plan
    expect(ipc.sessionPresence).not.toHaveBeenCalled();
  });

  it("an agent no plugin provides stays dormant — and KEEPS its binding", async () => {
    // The unknown store would answer "absent" and the absent branch wipes
    // bindings; but this session may resume perfectly once the plugin is
    // re-enabled. No wake, no probe, no presence check, binding intact.
    act(() =>
      deck.hydrate(
        restored({ agentType: "gemini", session: { id: "old", boundAt: "t" } }),
      ),
    );
    await settle();

    expect(pane().dormant).toBe(true);
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
    expect(ipc.sessionPresence).not.toHaveBeenCalled();
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
