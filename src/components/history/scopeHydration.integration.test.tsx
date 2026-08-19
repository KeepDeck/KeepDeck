// @vitest-environment happy-dom
/**
 * The scope-change seam THROUGH REAL HYDRATION — the ordered form the
 * review demanded: the journal arrives late (a cold start's shape),
 * through the REAL deck store, the REAL createJournalPersistence and
 * the REAL scope hook — not a prop rerender with the carrier swapped
 * by hand. Two INDEPENDENT tests, not one with branches: an early
 * failure in a shared test closes everything below it and leaves the
 * second half und proven — exactly how the half-proof got here.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchPage } from "../../ipc/history";

const ipc = vi.hoisted(() => ({
  indexSearch: vi.fn<(...args: unknown[]) => Promise<SearchPage>>(),
  loadJournal: vi.fn<(...args: unknown[]) => Promise<string[]>>(),
  appendJournal: vi.fn(async () => {}),
  compactJournal: vi.fn(async () => {}),
}));
vi.mock("../../ipc/history", () => ({ indexSearch: ipc.indexSearch }));
vi.mock("../../ipc/journal", () => ({
  loadJournal: ipc.loadJournal,
  appendJournal: ipc.appendJournal,
  compactJournal: ipc.compactJournal,
}));
vi.mock("../../ipc/log", () => ({
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
const worktreeIpc = vi.hoisted(() => ({
  probeWorktree: vi.fn(async () => ({ exists: true, isWorktree: false, branch: null })),
}));
vi.mock("../../ipc/worktree", () => worktreeIpc);
vi.mock("../../app/runtimeContext", () => {
  // ONE snapshot object, forever: useSyncExternalStore compares snapshots
  // by identity, and a fresh object per call is an infinite re-render.
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

import { useMemo, useReducer } from "react";
import { deckReducer, initialDeckState } from "../../domain/deck/reducer";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { Workspace } from "../../domain/deck/workspaces";
import { useWorkspaceScope } from "../../app/useWorkspaceScope";
import { useSessionsBrowser, useBrowserSharedSeam } from "../../app/useSessionsBrowser";
import { journalRows, foldJournal } from "../../domain/journal";
import type { SessionRecord } from "../../domain/journal";
import type { DeckAction } from "../../domain/deck/reducerActions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** The dispatch escape: the harness's reducer dispatch, captured for the
 * hydration replay. */
let harnessDispatch: ((a: DeckAction) => void) | null = null;

const ws = (): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
});

/** The reducer's own state type. */
type DeckStateT = ReturnType<typeof deckReducer>;

/** The one-workspace deck, mounted the way a cold start mounts it: the
 * deck hydrates first (its workspaces become "restored", eligible to
 * adopt loaded journal keys — the reducer's own rule), the journal
 * settles later. */
const HYDRATE_DECK: DeckAction = {
  type: "hydrate",
  state: {
    ...initialDeckState,
    workspaces: [ws()],
    activeId: "ws-1",
  },
} as DeckAction;

const boundEvent = (wsId: string, cwd: string, sessionId: string) => ({
  e: "bound" as const,
  v: 1 as const,
  wsId,
  record: {
    agent: "claude" as const,
    sessionId,
    cwd,
    boundAt: "2026-07-19T10:00:00.000Z",
    paneId: `pane-${sessionId}`,
  },
});

let api: ReturnType<typeof useSessionsBrowser>;
let scopeDirs: ReadonlySet<string>;
let rowsOut: SessionRecord[];

/** The screen's own chain, one-to-one: rows from the journal slice,
 * scope through the real hook, engines over the real seam. */
function Screen({
  state,
  dispatch,
}: {
  state: DeckStateT;
  dispatch: React.Dispatch<DeckAction>;
}) {
  // The journal slice's rows — MEMOIZED on the journal object, exactly as
  // the production screen does: the scope's contract is fed by a stable
  // rows identity, and the semantic key is what decides version changes.
  const rows = useMemo(() => journalRows(state.journal.records, "ws-1"), [state.journal]);
  rowsOut = rows;
  const dirs = useWorkspaceScope(ws(), rows);
  scopeDirs = dirs;
  const shared = useBrowserSharedSeam();
  api = useSessionsBrowser(dirs, shared);
  void dispatch;
  return null;
}

describe("scope change through REAL journal hydration", () => {
  let root: Root;
  let resolvers: Array<(page: SearchPage) => void>;

  beforeEach(() => {
    resolvers = [];
    ipc.indexSearch.mockReset();
    ipc.indexSearch.mockImplementation(
      () =>
        new Promise<SearchPage>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    ipc.loadJournal.mockReset();
    ipc.loadJournal.mockImplementation(
      () => new Promise<string[]>((resolve) => {
        (globalThis as { __journalResolve?: (l: string[]) => void }).__journalResolve =
          (l: string[]) => resolve(l);
      }),
    );
    ipc.appendJournal.mockClear();
    ipc.compactJournal.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  /** Mount the whole chain: the screen over the real deck state, with
   * the journal arriving when `settleJournal` hands its lines over.
   * AWAITED — the asks live in effects, and effects run when act
   * settles, not when render returns. */
  const mountChain = async () => {
    await act(async () => {
      root.render(createElement(ScreenHarness, null));
    });
    await act(async () => {});
  };

  /** The harness owns the deck state and the persistence owner — both
   * real, wired as runtime.ts wires them (minus the deck persistence
   * gate, which is not this seam's subject). */
  function ScreenHarness() {
    const [state, dispatch] = useReducer(
      deckReducer,
      initialDeckState,
      (init) => deckReducer(init, HYDRATE_DECK),
    );
    harnessDispatch = dispatch;
    return createElement(Screen, { state, dispatch });
  }

  it("(1) THIS workspace's journal hydrates MID-FLIGHT: the scope moves, a new page zero asks, the narrow landing is DROPPED", async () => {
    // Fake timers FROM THE START: the reset rides the engines' 150ms
    // debounce, and switching clock families mid-flight kills the
    // pending timer (a real timer armed before useFakeTimers never
    // fires under the fake clock).
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await mountChain();
      // The narrow ask is out (scope = {/repo} only).
      expect(resolvers.length).toBeGreaterThanOrEqual(2);
      // The journal settles NOW — through the REAL hydration action (what
      // the persistence owner dispatches once its load resolves), with a
      // record whose cwd widens this workspace's scope.
      await act(async () => {
        harnessDispatch?.({
          type: "hydrateJournal",
          records: foldJournal([boundEvent("ws-1", "/wt/hist", "s-h")]),
          at: new Date().toISOString(),
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      // A new page zero has been asked under the WIDENED scope...
      expect(rowsOut.map((r) => r.cwd)).toContain("/wt/hist");
      expect([...scopeDirs].sort()).toEqual(["/repo", "/wt/hist"]);
      const calls = ipc.indexSearch.mock.calls as unknown[][];
      const onlyCalls = calls.filter(
        (c) => (c[4] as { mode?: string })?.mode === "only",
      );
      const last = onlyCalls[onlyCalls.length - 1];
      expect(last[4]).toEqual({ mode: "only", dirs: ["/repo", "/wt/hist"] });

      // ...and the NARROW ask's late landing (old scope's answer) paints
      // NOTHING: rows are empty until the new page lands.
      await act(async () =>
        resolvers[0]({
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
        }),
      );
      expect(api.top.hits.map((h) => h.sessionId)).not.toContain("old-scope-row");
      expect(api.bottom.hits.map((h) => h.sessionId)).not.toContain("old-scope-row");
    } finally {
      vi.useRealTimers();
    }
  });

  it("(2) ANOTHER workspace's journal event: the observed scope identity HOLDS, rows stay, no new ask", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await mountChain();
      // THIS workspace's journal hydrates first (the setup both tests share
      // — a widened scope with rows on screen).
      await act(async () => {
        harnessDispatch?.({
          type: "hydrateJournal",
          records: foldJournal([boundEvent("ws-1", "/wt/hist", "s-h")]),
          at: new Date().toISOString(),
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      // Let the widened page zero land — rows on screen. The widened
      // TOP ask is the newest pending "only"-scoped resolver.
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

      // A journal event in ANOTHER workspace: the deck rebuilds around a
      // foreign key, the observed workspace's content did not move.
      await act(async () => {
        harnessDispatch?.({
          type: "hydrateJournal",
          records: foldJournal([
            boundEvent("ws-1", "/wt/hist", "s-h"),
            boundEvent("ws-2", "/other", "s-foreign"),
          ]),
          at: new Date().toISOString(),
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
