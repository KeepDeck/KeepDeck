// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { usePersistence } from "./usePersistence";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ipc = vi.hoisted(() => ({
  loadDeckState: vi.fn<() => Promise<string | null>>(),
  saveDeckState: vi.fn<(json: string) => Promise<void>>(() => Promise.resolve()),
  quarantineDeckState: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("../ipc/state", () => ipc);

const STORED = JSON.stringify({
  version: 1,
  activeId: "ws-1",
  focusByWs: {},
  selectByWs: {},
  workspaces: [
    {
      id: "ws-1",
      name: "restored",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [{ id: "pane-1", agentType: "claude" }],
    },
  ],
});

let deck: Deck;
let restoring: boolean;

function Probe() {
  deck = useDeck();
  restoring = usePersistence(deck).restoring;
  return null;
}

describe("usePersistence", () => {
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    ipc.loadDeckState.mockReset();
    ipc.saveDeckState.mockClear();
    ipc.quarantineDeckState.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  const mount = async () => {
    await act(async () => root.render(createElement(Probe)));
    // Let the load promise chain settle inside act.
    await act(async () => {});
  };

  it("restores the stored deck (panes dormant) and only then allows saves", async () => {
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();

    expect(restoring).toBe(false);
    expect(deck.workspaces.map((w) => w.id)).toEqual(["ws-1"]);
    expect(deck.workspaces[0].panes[0].dormant).toBe(true);

    // The post-hydrate save is debounced and writes the normalized document.
    await act(async () => vi.runOnlyPendingTimers());
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ipc.saveDeckState.mock.calls[0][0]).activeId).toBe("ws-1");
  });

  it("NEVER saves while the load is still pending — the store must not be wiped", async () => {
    let resolveLoad!: (json: string | null) => void;
    ipc.loadDeckState.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    await mount();

    // A user-driven change arrives before the load resolves.
    act(() =>
      deck.createWorkspace({
        id: "ws-9",
        name: "early",
        cwd: "/x",
        worktreeBaseDir: null,
        panes: [],
      }),
    );
    await act(async () => vi.runOnlyPendingTimers());
    expect(ipc.saveDeckState).not.toHaveBeenCalled(); // the invariant

    // Once the (empty) load settles, the change made DURING the load is
    // picked up and saved — nothing is lost, just deferred.
    await act(async () => resolveLoad(null));
    await act(async () => vi.runOnlyPendingTimers());
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(ipc.saveDeckState.mock.calls[0][0]).workspaces.map(
        (w: { id: string }) => w.id,
      ),
    ).toEqual(["ws-9"]);
  });

  it("quarantines an unusable document and starts empty", async () => {
    ipc.loadDeckState.mockResolvedValue("{corrupt");
    await mount();

    expect(ipc.quarantineDeckState).toHaveBeenCalledTimes(1);
    expect(restoring).toBe(false);
    expect(deck.workspaces).toEqual([]);
  });

  it("starts empty on first run (no stored state, nothing quarantined)", async () => {
    ipc.loadDeckState.mockResolvedValue(null);
    await mount();

    expect(restoring).toBe(false);
    expect(deck.workspaces).toEqual([]);
    expect(ipc.quarantineDeckState).not.toHaveBeenCalled();
  });
});
