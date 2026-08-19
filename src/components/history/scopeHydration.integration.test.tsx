// @vitest-environment happy-dom
/**
 * The scope-change seam on the REAL carrier — every link of the chain
 * is production code; the only doubles are at the chain's two ENDS
 * (the deck-persistence port — a permission input, not the carrier —
 * and the journal/ind IPC), per the review's rule: fakes are allowed
 * BEFORE the first production causal point and AFTER the last; inside,
 * no manual jumps. Concretely this file builds:
 *
 *   loadJournal (mock, deferred) -> createJournalPersistence (import,
 *   :NN) -> hydrateJournal dispatch -> deckReducer -> createDeckStore
 *   subscribe -> useSyncExternalStore -> journalRows ->
 *   useWorkspaceScope -> useSessionsBrowser -> indexSearch (mock).
 *
 * NOTHING dispatches hydrateJournal by hand: the persistence owner does
 * it once its deferred load resolves and the deck-persistence gate says
 * ready — exactly the production sequence of a cold start whose
 * journal settles late.
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchPage } from "../../ipc/history";

const ipc = vi.hoisted(() => ({
  indexSearch: vi.fn<(...args: unknown[]) => Promise<SearchPage>>(),
  loadJournal: vi.fn<(...args: unknown[]) => Promise<string[]>>(),
  appendJournal: vi.fn(async (..._args: unknown[]) => {}),
  compactJournal: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock("../../ipc/history", () => ({ indexSearch: ipc.indexSearch }));
vi.mock("../../ipc/journal", () => ({
  loadJournal: ipc.loadJournal,
  appendJournal: ipc.appendJournal,
  compactJournal: ipc.compactJournal,
}));
vi.mock("../../ipc/log", () => ({
  describeError: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
const worktreeIpc = vi.hoisted(() => ({
  probeWorktree: vi.fn(async () => ({ exists: true, isWorktree: false, branch: null })),
}));
vi.mock("../../ipc/worktree", () => worktreeIpc);
vi.mock("../../app/runtimeContext", () => {
  // One snapshot object forever: useSyncExternalStore compares by
  // identity; a fresh object per call is an infinite re-render.
  const snapshot = {
    scanning: false,
    revision: 1,
    scannedAgents: new Set<string>(),
    invalidated: new Set<string>(),
  };
  return {
    useAppRuntime: () => ({
      plugins: { pluginRegistries: { agents: { list: () => [] } } },
      sessionIndex: {
        ensureFresh: vi.fn(),
        snapshot: () => snapshot,
        subscribe: () => () => {},
      },
    }),
  };
});

import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import { encodeJournalEvent } from "../../domain/journal/persist";
import { journalRows } from "../../domain/journal";
import type { SessionRecord } from "../../domain/journal";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { DeckState } from "../../domain/deck";
import { createDeckStore, type DeckStore } from "../../app/deckStore";
import { createDeckActions } from "../../app/deckActions";
import type {
  DeckPersistence,
  DeckPersistenceSnapshot,
} from "../../app/deckPersistence";
import {
  createJournalPersistence,
  type JournalPersistence,
} from "../../app/journalPersistence";
import { useWorkspaceScope } from "../../app/useWorkspaceScope";
import {
  useSessionsBrowser,
  useBrowserSharedSeam,
} from "../../app/useSessionsBrowser";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const T = "2026-07-19T10:00:00.000Z";

const storedLine = (wsId: string, cwd: string, sessionId: string) =>
  encodeJournalEvent({
    e: "bound",
    v: 1,
    wsId,
    record: {
      agent: "claude",
      sessionId,
      cwd,
      boundAt: T,
      paneId: `pane-${sessionId}`,
    },
  });

/** The deck-persistence port double — a PERMISSION input (readiness),
 * not the carrier; the shape is the mutable-port idiom of
 * useJournalPersistence.test.ts:57-62. */
function mutablePersistence(initial: DeckPersistenceSnapshot): {
  port: DeckPersistence;
  set(next: DeckPersistenceSnapshot): void;
} {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    port: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose() {},
    },
    set(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The restored deck: ws-1 pane-less (the observed screen), ws-2 WITH a
 * pane — the shape witness 2 needs. Journal keys attach only to
 * RESTORED ids, so both ride the deck's hydrate action. */
const RESTORED_DECK: Pick<DeckState, "workspaces" | "activeId"> = {
  workspaces: [
    {
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "observed",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [],
    },
    {
      id: "ws-2",
      instance: createWorkspaceInstance(),
      name: "other",
      cwd: "/other",
      worktreeBaseDir: null,
      panes: [{ id: "ws-2-pane-1", agentType: "claude" }],
    },
  ],
  activeId: "ws-1",
};

let api: ReturnType<typeof useSessionsBrowser>;
let scopeDirs: ReadonlySet<string>;
let rowsOut: SessionRecord[];

/** The observed screen's own chain over the REAL store: the store's
 * subscription (useSyncExternalStore — the same wiring useDeck uses),
 * the journal slice, the real scope hook, the real engines. */
function Screen({ store }: { store: DeckStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const rows = journalRows(state.journal.records, "ws-1");
  rowsOut = rows;
  const dirs = useWorkspaceScope(RESTORED_DECK.workspaces[0], rows);
  scopeDirs = dirs;
  const shared = useBrowserSharedSeam();
  api = useSessionsBrowser(dirs, shared);
  return null;
}

interface Owners {
  store: DeckStore;
  persistence: ReturnType<typeof mutablePersistence>;
  journal: JournalPersistence;
  actions: ReturnType<typeof createDeckActions>;
}

/** One owner mount: the store, the persistence owner (started at
 * `restoring` — the real cold-start gate), the deck actions. The
 * journal's load is already in flight (deferred); the readiness flip
 * below releases the owner's hydrate — the production sequence. */
function Harness({ ready }: { ready: boolean }) {
  const [owners] = useState<Owners>(() => {
    const store = createDeckStore();
    const persistence = mutablePersistence({
      restoring: true,
      frozen: null,
    });
    const actions = createDeckActions(store);
    // The deck restores FIRST — its workspaces become the ids a loaded
    // journal may adopt (the reducer's own rule).
    actions.hydrate(RESTORED_DECK as DeckState);
    return {
      store,
      persistence,
      journal: createJournalPersistence(store, persistence.port),
      actions,
    };
  });
  useEffect(() => {
    if (!ready) return;
    owners.persistence.set({ restoring: false, frozen: null });
  }, [ready, owners]);
  harnessActions = owners.actions;
  return createElement(Screen, { store: owners.store });
}

/** The harness's deck actions — captured for witness 2's production
 * event (setPaneSession through the real creator). */
let harnessActions: ReturnType<typeof createDeckActions> | null = null;

describe("scope change on the REAL carrier", () => {
  let root: Root;
  let resolvers: Array<(page: SearchPage) => void>;
  let journalResolve: ((lines: string[]) => void) | null;

  beforeEach(() => {
    resolvers = [];
    journalResolve = null;
    ipc.indexSearch.mockReset();
    ipc.indexSearch.mockImplementation(
      () =>
        new Promise<SearchPage>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    ipc.loadJournal.mockReset();
    ipc.loadJournal.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          journalResolve = resolve;
        }),
    );
    ipc.appendJournal.mockClear();
    ipc.compactJournal.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = async (ready = false) => {
    harnessActions = null;
    await act(async () => {
      root.render(createElement(Harness, { ready }));
    });
    if (!harnessActions) throw new Error("harness actions not captured");
    await act(async () => {});
  };
  const releaseJournal = async (lines: string[]) => {
    await act(async () => {
      journalResolve?.(lines);
    });
  };

  it("WITNESS 1: the journal settles MID-FLIGHT — the scope widens, a new page zero asks, the narrow landing is DROPPED", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await mount(false);
      // The narrow ask is out (scope = {/repo} only) and STAYS in
      // flight — nothing resolves it yet.
      expect(resolvers.length).toBeGreaterThanOrEqual(2);
      const narrowAsk = resolvers[0];

      // The journal settles (deferred load resolves), then the
      // deck-persistence gate flips ready — the owner hydrates on its
      // OWN, the real cold-start sequence. No manual hydrateJournal
      // anywhere in this file.
      await releaseJournal([storedLine("ws-1", "/wt/hist", "s-h")]);
      await act(async () => {
        root.render(createElement(Harness, { ready: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      // The scope widened through the REAL chain...
      expect(rowsOut.map((r) => r.cwd)).toContain("/wt/hist");
      expect([...scopeDirs].sort()).toEqual(["/repo", "/wt/hist"]);
      // ...a new page zero asked under it...
      const calls = ipc.indexSearch.mock.calls as unknown[][];
      const onlyCalls = calls.filter(
        (c) => (c[4] as { mode?: string })?.mode === "only",
      );
      const last = onlyCalls[onlyCalls.length - 1];
      expect(last[4]).toEqual({ mode: "only", dirs: ["/repo", "/wt/hist"] });

      // ...and ONLY NOW the narrow ask lands — it must paint NOTHING.
      await act(async () => {
        narrowAsk({
          hits: [{
            agent: "claude",
            sessionId: "old-scope-row",
            reference: "/old",
            cwd: "/repo",
            title: null,
            transcriptPath: null,
            mtime: 1,
            snippet: null,
          }],
          total: 1,
        });
      });
      expect(api.top.hits.map((h) => h.sessionId)).not.toContain("old-scope-row");
      expect(api.bottom.hits.map((h) => h.sessionId)).not.toContain("old-scope-row");
    } finally {
      vi.useRealTimers();
    }
  });

  it("WITNESS 2: ANOTHER workspace's journal event — observed scope identity holds, rows stay, no re-ask", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await mount(false);
      await releaseJournal([storedLine("ws-1", "/wt/hist", "s-h")]);
      await act(async () => {
        root.render(createElement(Harness, { ready: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      // The widened page zero lands — rows on screen.
      const callsAfterHydrate = ipc.indexSearch.mock.calls.length;
      const onlyIdx = [...ipc.indexSearch.mock.calls]
        .map((c, i) => ({ i, mode: (c[4] as { mode?: string })?.mode }))
        .filter((c) => c.mode === "only")
        .pop()!.i;
      await act(async () =>
        resolvers[onlyIdx]({
          hits: [{
            agent: "claude",
            sessionId: "hist-row",
            reference: "/hist",
            cwd: "/wt/hist",
            title: null,
            transcriptPath: null,
            mtime: 1,
            snippet: null,
          }],
          total: 1,
        }),
      );
      expect(api.top.hits.map((h) => h.sessionId)).toContain("hist-row");
      const dirsBefore = scopeDirs;
      const rowsBefore = rowsOut.length;

      // A REAL binding event in ANOTHER workspace: the production action
      // creator (setPaneSession), not a hand-built journal event — the
      // reducer writes the event's form, the test only causes it.
      await act(async () => {
        harnessActions?.setPaneSession("ws-2", "ws-2-pane-1", {
          id: "s-foreign",
          boundAt: new Date().toISOString(),
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      expect(scopeDirs).toBe(dirsBefore); // identity held
      expect(rowsOut).toHaveLength(rowsBefore); // nothing blanked
      expect(ipc.indexSearch.mock.calls.length).toBe(callsAfterHydrate); // no re-ask
    } finally {
      vi.useRealTimers();
    }
  });
});
