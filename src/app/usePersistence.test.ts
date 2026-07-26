// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { createDeckStore } from "./deckStore";
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

// The launch policy: hydration must wait for it and obey it. The real manager
// reads settings.json over IPC, which this test has no business exercising.
const settings = vi.hoisted(() => ({
  parkAgentsOnLaunch: false,
  initSettings: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("./settingsManager", () => ({
  initSettings: settings.initSettings,
  getSettings: () => ({ parkAgentsOnLaunch: settings.parkAgentsOnLaunch }),
}));

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
let frozen: ReturnType<typeof usePersistence>["frozen"];

function Probe() {
  // Fresh per mount (a bare call would rebuild it on every render).
  const [store] = useState(createDeckStore);
  deck = useDeck(store);
  ({ restoring, frozen } = usePersistence(deck));
  return null;
}

describe("usePersistence", () => {
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    ipc.loadDeckState.mockReset();
    ipc.saveDeckState.mockClear();
    ipc.quarantineDeckState.mockClear();
    settings.parkAgentsOnLaunch = false;
    settings.initSettings.mockClear();
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

  it("restores the stored deck (panes idle) and only then allows saves", async () => {
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();

    expect(restoring).toBe(false);
    expect(deck.workspaces.map((w) => w.id)).toEqual(["ws-1"]);
    expect(deck.workspaces[0].panes[0].idle).toEqual({
      reason: "waking",
      origin: "restore",
    });

    // The post-hydrate save is debounced and writes the normalized document.
    await act(async () => vi.runOnlyPendingTimers());
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ipc.saveDeckState.mock.calls[0][0]).activeId).toBe("ws-1");
  });

  it("restores panes RISING whatever the launch policy says", async () => {
    // Hydration answers "what does this document say". Whether these panes may
    // start is the orchestrator's question, asked live and asked again every
    // time the answer could change — deciding it here once is what let a pane
    // in an unopened workspace ignore a setting the user had since flipped.
    settings.parkAgentsOnLaunch = true;
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();

    expect(deck.workspaces[0].panes[0].idle).toEqual({
      reason: "waking",
      origin: "restore",
    });
  });

  it("waits for the settings load before hydrating — a slow read must not mean 'wake everything'", async () => {
    // The orchestrator acts the moment panes appear. Hydrating ahead of the
    // settings would let it find them while the policy still reads its
    // default, start the active workspace's agents, and then have nothing to
    // undo: a running agent is deliberately never stopped by a preference.
    settings.parkAgentsOnLaunch = true;
    let settleSettings!: () => void;
    settings.initSettings.mockReturnValue(
      new Promise<void>((resolve) => {
        settleSettings = resolve;
      }),
    );
    ipc.loadDeckState.mockResolvedValue(STORED);

    await mount();
    expect(deck.workspaces).toHaveLength(0); // deck read, policy not known yet

    await act(async () => settleSettings());
    expect(deck.workspaces).toHaveLength(1);
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
        instance: createWorkspaceInstance(),
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

  it("saves a structural change IMMEDIATELY — a new pane must never be lost", async () => {
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();
    await act(async () => vi.runOnlyPendingTimers());
    ipc.saveDeckState.mockClear(); // drop the boot save

    act(() =>
      deck.addAgentPane("ws-1", { id: "pane-9", agentType: "codex" }),
    );
    // No timer advance: the save must not wait for any debounce.
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(ipc.saveDeckState.mock.calls[0][0]);
    expect(saved.workspaces[0].panes.map((p: { id: string }) => p.id)).toEqual([
      "pane-1",
      "pane-9",
    ]);
  });

  it("a suspend saves IMMEDIATELY — quit must not restart the agent the user parked", async () => {
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();
    // The revive sweep lives elsewhere; stand in for it so the pane is live
    // and can actually be suspended.
    act(() => deck.clearPaneIdle("ws-1", "pane-1"));
    await act(async () => vi.runOnlyPendingTimers());
    ipc.saveDeckState.mockClear();

    act(() => deck.suspendPane("ws-1", "pane-1"));

    // No timer advance: the intent must not ride the debounce, because ⌘Q
    // never reaches the webview and there is no flush on the Rust side.
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(ipc.saveDeckState.mock.calls[0][0]);
    expect(saved.workspaces[0].panes[0].idle).toMatchObject({
      reason: "suspended",
    });
  });

  it("waking a suspended pane saves IMMEDIATELY too — the marker must not outlive the intent", async () => {
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();
    act(() => deck.clearPaneIdle("ws-1", "pane-1"));
    act(() => deck.suspendPane("ws-1", "pane-1"));
    await act(async () => vi.runOnlyPendingTimers());
    ipc.saveDeckState.mockClear();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));

    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1);
    expect(ipc.saveDeckState.mock.calls[0][0]).not.toContain("suspended");
  });

  it("the sweep waking a pane rides the debounce instead of forcing a write", async () => {
    // The earlier version of this test asserted "no save at all" and passed on
    // the very regression it named: a non-durable marker leaves the document
    // byte-identical, so the effect returns at the `serialized === lastSaved`
    // guard before the immediate signature is ever consulted. Pair the wake
    // with a change that DOES alter the document, and the two outcomes split:
    // immediate would write now, debounced writes on the timer.
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();
    await act(async () => vi.runOnlyPendingTimers());
    ipc.saveDeckState.mockClear();

    act(() => {
      deck.clearPaneIdle("ws-1", "pane-1");
      deck.setPaneAutoTitle("ws-1", "pane-1", "fixing auth");
    });
    expect(ipc.saveDeckState).not.toHaveBeenCalled();

    await act(async () => vi.runOnlyPendingTimers());
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1);
    expect(ipc.saveDeckState.mock.calls[0][0]).not.toContain("idle");
  });

  it("clearing a marker alone changes nothing on disk at all", async () => {
    // The weaker half of the pair above, kept because it pins WHY: the wake
    // is invisible to the document, so there is nothing to write either way.
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();
    await act(async () => vi.runOnlyPendingTimers());
    ipc.saveDeckState.mockClear();

    act(() => deck.clearPaneIdle("ws-1", "pane-1"));
    await act(async () => vi.runOnlyPendingTimers());
    expect(ipc.saveDeckState).not.toHaveBeenCalled();
  });

  it("a session binding saves IMMEDIATELY — quit must not lose it", async () => {
    // ⌘Q is a native menu role that never reaches the webview, so a binding
    // riding the debounce would vanish with it — and next launch would
    // resume the directory's newest session, possibly someone else's
    // conversation.
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();
    await act(async () => vi.runOnlyPendingTimers());
    ipc.saveDeckState.mockClear(); // drop the boot save

    act(() =>
      deck.setPaneSession("ws-1", "pane-1", { id: "s-1", boundAt: "t" }),
    );
    // No timer advance: the save must not wait for any debounce.
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(ipc.saveDeckState.mock.calls[0][0]);
    expect(saved.workspaces[0].panes[0].session.id).toBe("s-1");
  });

  it("cosmetic churn cannot starve the save past the max wait", async () => {
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();
    await act(async () => vi.runOnlyPendingTimers());
    ipc.saveDeckState.mockClear();

    // A busy TUI retitling itself every 400 ms reschedules a plain debounce
    // forever — the maxWait cap must force a save within ~2 s anyway.
    for (let i = 0; i < 6; i++) {
      act(() => deck.setPaneAutoTitle("ws-1", "pane-1", `✳ thinking ${i}`));
      await act(async () => vi.advanceTimersByTime(400));
    }
    expect(ipc.saveDeckState).toHaveBeenCalled();
    const calls = ipc.saveDeckState.mock.calls;
    const saved = JSON.parse(calls[calls.length - 1][0]);
    expect(saved.workspaces[0].panes[0].autoTitle).toMatch(/✳ thinking/);
  });

  it("a FAILED save stays dirty and is retried — never marked saved", async () => {
    // Advancing the saved-refs before the IPC resolves marks a failed write
    // as done; the guard then suppresses every retry and the last pre-quit
    // change is silently lost.
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();
    await act(async () => vi.runOnlyPendingTimers());
    ipc.saveDeckState.mockClear();

    ipc.saveDeckState.mockRejectedValueOnce(new Error("disk full"));
    act(() =>
      deck.addAgentPane("ws-1", { id: "pane-9", agentType: "codex" }),
    );
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1); // the failed attempt
    await act(async () => {}); // let the rejection settle → retry scheduled

    await act(async () => vi.advanceTimersByTime(500));
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(2); // retried
    const saved = JSON.parse(ipc.saveDeckState.mock.calls[1][0]);
    expect(saved.workspaces[0].panes.map((p: { id: string }) => p.id)).toEqual([
      "pane-1",
      "pane-9",
    ]);

    // The retry succeeded → clean; nothing keeps re-saving.
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(2);
  });

  it("a change landing during an in-flight save is saved right after it", async () => {
    ipc.loadDeckState.mockResolvedValue(STORED);
    await mount();
    await act(async () => vi.runOnlyPendingTimers());
    ipc.saveDeckState.mockClear();

    let resolveSave!: () => void;
    ipc.saveDeckState.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );
    act(() =>
      deck.addAgentPane("ws-1", { id: "pane-9", agentType: "codex" }),
    );
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1); // in flight

    // A binding lands while the save is still round-tripping.
    act(() =>
      deck.setPaneSession("ws-1", "pane-9", { id: "s-9", boundAt: "t" }),
    );
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1); // no overlap

    await act(async () => resolveSave());
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(2); // follow-up save
    const saved = JSON.parse(ipc.saveDeckState.mock.calls[1][0]);
    expect(saved.workspaces[0].panes[1].session.id).toBe("s-9");
  });

  it("quarantines an unusable document and starts empty", async () => {
    ipc.loadDeckState.mockResolvedValue("{corrupt");
    await mount();

    expect(ipc.quarantineDeckState).toHaveBeenCalledTimes(1);
    expect(restoring).toBe(false);
    expect(deck.workspaces).toEqual([]);
  });

  it("PARKS when the read itself fails — an empty deck must not land on a good file", async () => {
    // A rejecting read is not an unusable document: the file is probably
    // intact and we have no idea what is in it, so there is nothing to
    // condemn and nothing to quarantine. Starting empty is fine; SAVING that
    // empty deck is how a transient IPC hiccup at boot costs every workspace
    // the user has — the first render would flush right over it.
    ipc.loadDeckState.mockRejectedValue(new Error("backend not ready"));
    await mount();

    expect(restoring).toBe(false);
    expect(deck.workspaces).toEqual([]);
    expect(ipc.quarantineDeckState).not.toHaveBeenCalled();
    expect(ipc.saveDeckState).not.toHaveBeenCalled();
    // The park has to be VISIBLE, not just a ref inside this hook. `frozen`
    // is what gates the journal hydrate and the skills prune in App — both
    // of which would otherwise run against a deck that is empty only because
    // the read failed, and delete a session history and a skills tree that
    // are perfectly intact on disk.
    expect(frozen).toEqual({ kind: "unreadable" });

    // And it stays parked: a later change must not reach disk either.
    act(() =>
      deck.createWorkspace({
        id: "ws-9",
        instance: createWorkspaceInstance(),
        name: "unsaved",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-9", agentType: "claude" }],
      }),
    );
    await act(async () => vi.runOnlyPendingTimers());
    expect(ipc.saveDeckState).not.toHaveBeenCalled();
  });

  it("PARKS on a deck above the compatibility floor: untouched, never saved over", async () => {
    ipc.loadDeckState.mockResolvedValue(
      JSON.stringify({ version: 99, minVersion: 99, workspaces: [] }),
    );
    await mount();

    // The two parks are told apart by `kind`: the banner names the revision
    // for this one, and has nothing truthful to say about the other.
    expect(frozen).toEqual({ kind: "newer-build", version: 99, minVersion: 99 });
    // Parked ≠ corrupt: the file is NOT quarantined — it must survive us.
    expect(ipc.quarantineDeckState).not.toHaveBeenCalled();
    expect(deck.workspaces).toEqual([]);

    // Whatever the user does in the parked session, nothing reaches disk.
    act(() =>
      deck.createWorkspace({
        id: "ws-9",
        instance: createWorkspaceInstance(),
        name: "doomed",
        cwd: "/x",
        worktreeBaseDir: null,
        panes: [],
      }),
    );
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(ipc.saveDeckState).not.toHaveBeenCalled();
  });

  it("reads a NEWER deck whose floor admits us, preserving its unknown fields", async () => {
    ipc.loadDeckState.mockResolvedValue(
      JSON.stringify({
        version: 99,
        minVersion: 1,
        activeId: "ws-1",
        focusByWs: {},
        selectByWs: {},
        futureTopLevel: { theyKnow: true },
        workspaces: [
          {
            id: "ws-1",
            name: "restored",
            cwd: "/repo",
            worktreeBaseDir: null,
            futureWsField: 7,
            panes: [{ id: "pane-1", agentType: "claude", futurePaneField: "x" }],
          },
        ],
      }),
    );
    await mount();

    expect(frozen).toBeNull();
    expect(deck.workspaces.map((w) => w.id)).toEqual(["ws-1"]);

    // The boot save round-trips the future fields verbatim.
    await act(async () => vi.runOnlyPendingTimers());
    const saved = JSON.parse(
      ipc.saveDeckState.mock.calls[ipc.saveDeckState.mock.calls.length - 1][0],
    );
    expect(saved.futureTopLevel).toEqual({ theyKnow: true });
    expect(saved.workspaces[0].futureWsField).toBe(7);
    expect(saved.workspaces[0].panes[0].futurePaneField).toBe("x");
  });

  it("starts empty on first run (no stored state, nothing quarantined)", async () => {
    ipc.loadDeckState.mockResolvedValue(null);
    await mount();

    expect(restoring).toBe(false);
    expect(deck.workspaces).toEqual([]);
    expect(ipc.quarantineDeckState).not.toHaveBeenCalled();
  });
});
