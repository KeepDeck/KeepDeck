// @vitest-environment happy-dom
/**
 * The scope-change seam on the REAL carrier — every link of the chain
 * is production code. Doubled modules (the vi.mock list, verbatim):
 * ipc/history (indexSearch), ipc/journal (loadJournal deferred,
 * appendJournal, compactJournal), ipc/log, ipc/worktree,
 * app/runtimeContext (a fixed session-index snapshot — one object
 * forever, useSyncExternalStore compares by identity). Of these, only
 * the deck-persistence PORT (a hand-built mutable double, the
 * permission input) and loadJournal sit at the chain's causal ends;
 * the rest are ambient frame no test of this seam needs real. The
 * review's rule holds: fakes allowed BEFORE the first production
 * causal point and AFTER the last; inside — no manual jumps:
 *
 *   deferred loadJournal (mock) -> createJournalPersistence ->
 *   hydrateJournal dispatch (the OWNER's, never the test's) ->
 *   deckReducer inside createDeckStore -> store subscription ->
 *   useSyncExternalStore -> journalRows -> useWorkspaceScope ->
 *   useSessionsBrowser -> indexSearch (mock).
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
import { useMemo } from "react";
import { useSyncExternalStore } from "react";
import { encodeJournalEvent } from "../../domain/journal/persist";
import { emptyJournal, journalRows } from "../../domain/journal";
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
 * useJournalPersistence.test.ts:57-62. Counts its live subscriptions so
 * the teardown witness can observe silence, not just a call. */
function mutablePersistence(initial: DeckPersistenceSnapshot): {
  port: DeckPersistence;
  set(next: DeckPersistenceSnapshot): void;
  subscriberCount(): number;
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
    subscriberCount: () => listeners.size,
  };
}

/** The restored deck: ws-1 pane-less (the observed screen), ws-2 WITH a
 * pane — the shape witness 2 needs. Journal keys attach only to
 * RESTORED ids, so both ride the deck's hydrate action. The journal
 * slice is the EMPTY one — every record in this file arrives through
 * the real chain (the owner's hydrate dispatch, the reducer's bound
 * event), never pre-seeded here. Typed as the FULL DeckState with NO
 * cast: the compiler names anything missing (a `as DeckState` on the
 * literal would silence exactly that naming). */
const RESTORED_DECK: DeckState = {
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
  journal: emptyJournal,
  viewByWs: {},
};

let api: ReturnType<typeof useSessionsBrowser>;
let scopeDirs: ReadonlySet<string>;
let rowsOut: SessionRecord[];

/** The observed screen's own chain over the REAL store: the store's
 * subscription (useSyncExternalStore — the same wiring useDeck uses),
 * the journal slice, the real scope hook, the real engines. The
 * workspace object comes FROM THE STORE'S STATE (not a module
 * constant) and the rows are memoized on the journal slice — the
 * production screen's own discipline (DeckStage.tsx:72). */
function Screen({ store }: { store: DeckStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const ws = state.workspaces.find((w) => w.id === "ws-1")!;
  const rows = useMemo(
    () => journalRows(state.journal.records, "ws-1"),
    [state.journal, state.journal.records],
  );
  rowsOut = rows;
  const dirs = useWorkspaceScope(ws, rows);
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
 * below releases the owner's hydrate — the production sequence. The
 * owner is DISPOSED on unmount, as the runtime does. */
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
    actions.hydrate(RESTORED_DECK);
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
  useEffect(() => () => owners.journal.dispose(), [owners]);
  harnessActions = owners.actions;
  harnessStore = owners.store;
  harnessPersistence = owners.persistence;
  return createElement(Screen, { store: owners.store });
}

/** The harness's deck actions — captured for witness 2's production
 * event (setPaneSession through the real creator). */
let harnessActions: ReturnType<typeof createDeckActions> | null = null;
/** The harness's store — the witness's view into the REAL state (the
 * positive assertion that the foreign event actually happened). */
let harnessStore: DeckStore | null = null;
/** The harness's persistence double — for the teardown witness. */
let harnessPersistence: ReturnType<typeof mutablePersistence> | null = null;

/** ws-1's journal projection by content — the immobility snapshot. */
const ws1Projection = (): string =>
  JSON.stringify(
    (harnessStore?.getSnapshot().journal.records["ws-1"] ?? []).map((r) => ({
      sessionId: r.sessionId,
      cwd: r.cwd,
      state: r.state,
    })),
  );

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
    harnessStore = null;
    harnessPersistence = null;
    await act(async () => {
      root.render(createElement(Harness, { ready }));
    });
    if (!harnessActions || !harnessStore || !harnessPersistence) {
      throw new Error("harness owners not captured");
    }
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
      // The narrow ask is out — identified BY KEY, not by position: it
      // is the only-scope call over the pre-hydration set.
      const firstCall = ipc.indexSearch.mock.calls[0] as unknown[];
      expect(firstCall[4]).toEqual({ mode: "only", dirs: ["/repo"] });
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

      // PRECONDITION, positive and explicit: the hydration has COMPLETED
      // before any foreign event — the loaded ws-1 record is IN the
      // store AND the scope has already widened. Without this a
      // catch-up hydration triggered by the event itself would mask as
      // the very immobility under test (the owner subscribes to the
      // deck; its drain re-reads readiness).
      expect(
        harnessStore!.getSnapshot().journal.records["ws-1"]?.map(
          (r) => r.sessionId,
        ),
      ).toEqual(["s-h"]);
      expect([...scopeDirs].sort()).toEqual(["/repo", "/wt/hist"]);
      // Negative half of the precondition: the foreign record does NOT
      // exist yet — the store is clean of ws-2 BEFORE the event fires.
      // The positive halves above say hydration has landed; this one
      // pins the ORDER (an event fired before the settle would leave
      // ws-2's record here already, and this line would name it).
      expect(
        harnessStore!.getSnapshot().journal.records["ws-2"],
      ).toBeUndefined();

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
      const projectionBefore = ws1Projection();

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
      // Let the owner's append-drain microtasks settle (the mock
      // appendJournal resolves instantly, but the flush is async).
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });

      // POSITIVE: the event HAPPENED — ws-2's record exists in the REAL
      // store's journal now (by material, not by call-spy). Without
      // this, every assertion below is vacuous: they only say nothing
      // moved, which is equally true when nothing happened.
      expect(
        harnessStore!.getSnapshot().journal.records["ws-2"]?.map(
          (r) => r.sessionId,
        ),
      ).toEqual(["s-foreign"]);

      // The event's OWN TRACE on the append wire: the hydrated ws-1
      // record never rides it (hydrateJournal writes records, not the
      // outbox), so the ws-2 bound event in the append log can only be
      // the live event's. What this wire does NOT prove is the order:
      // the owner's drain is gated until hydration completes
      // (journalPersistence.ts:50), so an event fired BEFORE the
      // settle still appends AFTER it — the wire says "append after",
      // not "event after". The order is pinned by the negative
      // precondition above (no ws-2 record before the event), which an
      // early-fired event breaks by leaving its record where that line
      // looks.
      const appendedWs = ipc.appendJournal.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("ws-2"));
      expect(appendedWs.length).toBeGreaterThan(0);

      // Immobility by CONTENT (not length — a substitution would keep
      // the count), identity of the scope set, and no re-ask.
      expect(ws1Projection()).toBe(projectionBefore);
      expect(scopeDirs).toBe(dirsBefore);
      expect(ipc.indexSearch.mock.calls.length).toBe(callsAfterHydrate);
    } finally {
      vi.useRealTimers();
    }
  });

  it("TEARDOWN: the owner disposes with the harness — silence after unmount, observed", async () => {
    vi.useFakeTimers();
    try {
      await mount(false);
      // The store subscription and the journal owner's persistence
      // subscription are live while mounted...
      expect(harnessPersistence!.subscriberCount()).toBeGreaterThan(0);
      await act(async () => {
        root.render(createElement("div", null));
      });
      // ...and after unmount: no store subscribers left, no timers armed.
      // The criterion is observable silence, not a dispose() call sighted.
      expect(harnessPersistence!.subscriberCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
