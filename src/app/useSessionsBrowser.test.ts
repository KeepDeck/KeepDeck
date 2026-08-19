// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexFolderScope, SearchHit, SearchPage } from "../ipc/history";

const ipc = vi.hoisted(() => ({
  indexSearch: vi.fn<
    (
      query: string,
      limit: number,
      offset: number,
      agent: undefined,
      folders?: IndexFolderScope,
    ) => Promise<SearchPage>
  >(),
}));
vi.mock("../ipc/history", () => ({ indexSearch: ipc.indexSearch }));

import {
  useSessionsBrowser,
  type BrowserSharedSeam,
  type SessionsBrowserApi,
} from "./useSessionsBrowser";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** The shared seam's stand-in: fixed revision/scanning, a keyed table the
 * tests may pre-fill, and recording declares. */
const sharedOf = (over: Partial<BrowserSharedSeam> = {}): BrowserSharedSeam => ({
  scanning: false,
  revision: 1,
  scannedAgents: new Set(["claude"]),
  invalidated: new Set(),
  enrichment: {
    entries: new Map(),
    pending: false,
    declare: vi.fn(),
  },
  ensureFresh: vi.fn(),
  transcript: vi.fn(() => Promise.resolve([])),
  ...over,
});

const mkHits = (from: number, count: number): SearchHit[] =>
  Array.from({ length: count }, (_, i) => ({
    agent: "claude",
    sessionId: `s-${from + i}`,
    reference: `/store/s-${from + i}`,
    cwd: "/wt/kd-x",
    title: null,
    transcriptPath: null,
    mtime: 1000 - (from + i),
    snippet: null,
  }));

let api: SessionsBrowserApi;
let shared: BrowserSharedSeam;

function Probe({ dirs }: { dirs?: ReadonlySet<string> }) {
  api = useSessionsBrowser(dirs ?? new Set(["/wt/kd-x", "/gone"]), shared);
  return null;
}

describe("useSessionsBrowser — two folder-scoped engines", () => {
  let root: Root;
  /** Pending indexSearch resolutions, in call order. */
  let resolvers: ((page: SearchPage) => void)[];

  beforeEach(() => {
    resolvers = [];
    ipc.indexSearch.mockReset();
    ipc.indexSearch.mockImplementation(
      () =>
        new Promise<SearchPage>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    shared = sharedOf();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = (dirs?: ReadonlySet<string>) =>
    act(async () => root.render(createElement(Probe, { dirs })));
  const rerender = (dirs?: ReadonlySet<string>) =>
    act(async () => root.render(createElement(Probe, { dirs })));

  /** The n-th fired call's folder scope — THE assertion this suite exists
   * for: membership rides in the query itself. */
  const scopeOfCall = (n: number): IndexFolderScope | undefined =>
    ipc.indexSearch.mock.calls[n]?.[4];

  it("a SCOPE CHANGE starts a NEW page zero — old rows leave, pages don't splice onto them", async () => {
    // The workspace's folder set grows while the browser is mounted (the
    // journal arrives after the screen, on every cold start where it
    // settles late). The ask's scope moves — and the change MUST read as
    // a new question: fresh page zero under a new generation, old rows
    // gone, the next page carrying offset 0 of the NEW area. On the
    // current code the scope only re-bakes the fetcher: the generation
    // never rises, the old rows stay on screen, and a later page arrives
    // from the NEW area spliced at the OLD rows' length — a mixed list.
    const OLD = new Set(["/wt/kd-x"]);
    const NEW = new Set(["/wt/kd-x", "/wt/hist"]);

    vi.useFakeTimers();
    try {
      await act(async () =>
        vi.advanceTimersByTimeAsync(0).then(() =>
          root.render(createElement(Probe, { dirs: OLD })),
        ),
      );
      // Page zeros of the OLD scope land (top fires first, then bottom):
      // 2 rows on screen in the bottom block.
      await act(async () =>
        resolvers[0]({ hits: [], total: 0 }),
      );
      await act(async () =>
        resolvers[1]({ hits: mkHits(0, 2), total: 30 }),
      );
      expect(api.bottom.hits).toHaveLength(2);
      expect(api.bottom.total).toBe(30);

      // The scope GROWS (the journal settled) — and the change rides the
      // debounced re-ask, so the timer must fire before its ask exists.
      await act(async () =>
        vi.advanceTimersByTimeAsync(0).then(() =>
          root.render(createElement(Probe, { dirs: NEW })),
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      // The old rows must NOT remain under the new scope...
      expect(api.bottom.hits).toHaveLength(0);
      // ...and the next ask must be page ZERO of the new area — not an
      // offset-2 fetch spliced onto the old rows.
      const calls = ipc.indexSearch.mock.calls;
      const last = calls[calls.length - 1];
      expect(last[2]).toBe(0); // offset
      expect(last[4]).toEqual({ mode: "except", dirs: [...NEW] });
      // The landing under the new generation paints only the new area.
      await act(async () =>
        resolvers[resolvers.length - 1]({ hits: mkHits(50, 3), total: 3 }),
      );
      expect(api.bottom.hits.map((h) => h.sessionId)).toEqual([
        "s-50",
        "s-51",
        "s-52",
      ]);
      expect(api.bottom.total).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the two asks carry Only and Except of the SAME directory set", async () => {
    await mount(new Set(["/wt/kd-x"]));
    // Two asks fire on mount — top first, bottom second (engine order).
    expect(ipc.indexSearch).toHaveBeenCalledTimes(2);
    expect(scopeOfCall(0)).toEqual({ mode: "only", dirs: ["/wt/kd-x"] });
    expect(scopeOfCall(1)).toEqual({ mode: "except", dirs: ["/wt/kd-x"] });
  });

  it("each block pages ITS OWN engine; one text searches both", async () => {
    await mount();
    await act(async () => resolvers[0]({ hits: mkHits(0, 50), total: 123 }));
    await act(async () => resolvers[1]({ hits: mkHits(0, 30), total: 456 }));

    act(() => api.bottom.loadMore());
    expect(ipc.indexSearch).toHaveBeenLastCalledWith(
      "",
      20,
      30,
      undefined,
      { mode: "except", dirs: ["/wt/kd-x", "/gone"] },
    );
    act(() => api.top.loadMore());
    expect(ipc.indexSearch).toHaveBeenLastCalledWith(
      "",
      20,
      50,
      undefined,
      { mode: "only", dirs: ["/wt/kd-x", "/gone"] },
    );

    // A typed query drives BOTH engines' page zero, one text.
    ipc.indexSearch.mockClear();
    resolvers.length = 0;
    vi.useFakeTimers();
    try {
      act(() => api.search("auth"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(ipc.indexSearch).toHaveBeenCalledTimes(2);
      expect(ipc.indexSearch.mock.calls[0]?.[0]).toBe("auth");
      expect(ipc.indexSearch.mock.calls[1]?.[0]).toBe("auth");
      expect(scopeOfCall(0)?.mode).toBe("only");
      expect(scopeOfCall(1)?.mode).toBe("except");
      expect(api.query).toBe("auth");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a revision bump refreshes BOTH blocks; a stale page never lands", async () => {
    await mount();
    // Page zeros land.
    await act(async () => resolvers[0]({ hits: mkHits(0, 3), total: 3 }));
    await act(async () => resolvers[1]({ hits: mkHits(10, 4), total: 4 }));
    expect(api.top.total).toBe(3);
    expect(api.bottom.total).toBe(4);

    // The index moved: both engines re-ask page zero under the new
    // generation; the STALE bottom page (fired pre-bump) must not land.
    shared = sharedOf({ revision: 2 });
    await rerender();
    expect(ipc.indexSearch).toHaveBeenCalledTimes(4);
    await act(async () => resolvers[3]({ hits: mkHits(20, 5), total: 5 }));
    expect(api.bottom.total).toBe(5);
    await act(async () => resolvers[2]({ hits: mkHits(30, 9), total: 999 }));
    expect(api.bottom.total).toBe(5); // the stale answer changed nothing
  });

  it("a page arriving after its query changed is dropped — per engine", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => resolvers[0]({ hits: mkHits(0, 2), total: 2 }));
      await act(async () => resolvers[1]({ hits: mkHits(5, 2), total: 2 }));

      act(() => api.search("auth"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      // The OLD bottom page lands after the new query was asked: dropped.
      await act(async () => resolvers[1]({ hits: mkHits(50, 20), total: 20 }));
      expect(api.bottom.hits).toHaveLength(2); // untouched, still the old rows
      // The new query's page zeros: top fired first (resolvers[2]), the
      // bottom's is the third pending resolution.
      await act(async () => resolvers[2]({ hits: mkHits(60, 5), total: 5 }));
      expect(api.top.hits).toHaveLength(5);
      await act(async () => resolvers[3]({ hits: mkHits(70, 6), total: 6 }));
      expect(api.bottom.hits).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shared seam fields pass through — scanning, enrichment, ensureFresh", async () => {
    const ensureFresh = vi.fn();
    shared = sharedOf({
      scanning: true,
      revision: 7,
      ensureFresh,
      enrichment: {
        entries: new Map([["claude:s-1", { kind: "absent" as const }]]),
        pending: true,
        declare: vi.fn(),
      },
    });
    await mount();
    expect(api.scanning).toBe(true);
    expect(api.enrichment.pending).toBe(true);
    expect(
      api.enrichment.entries.get("claude:s-1"),
    ).toEqual({ kind: "absent" });
    act(() => api.ensureFresh());
    expect(ensureFresh).toHaveBeenCalledTimes(1);
  });

  it("pages arrive FULL from each block's own query — nothing fetched to throw away", async () => {
    // The counter invariant's other half: numerator and denominator come
    // from the block's own response — asserted by the totals being the
    // ENGINE's answer, not a locally filtered count.
    await mount();
    await act(async () => resolvers[0]({ hits: mkHits(0, 50), total: 500 }));
    expect(api.top.hits).toHaveLength(50);
    expect(api.top.total).toBe(500);
    expect(api.top.hasMore).toBe(true);
  });

  it("the first-page flag: true while either block's page zero rides, gone when both land", async () => {
    // Binary, no machine timings — fake timers hold the debounce, the
    // pending resolvers hold the flight. The ask is visible work, not a
    // freeze: old rows STAY while the new ones ride (nothing is cleared
    // until the new answer lands), and the flag says why.
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => resolvers[0]({ hits: mkHits(0, 2), total: 2 }));
      await act(async () => resolvers[1]({ hits: mkHits(5, 2), total: 2 }));
      expect(api.firstPagePending).toBe(false);

      act(() => api.search("auth"));
      // During the debounce: still the old answer, no pending yet.
      expect(api.firstPagePending).toBe(false);
      expect(api.bottom.hits).toHaveLength(2); // old rows intact
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150); // the debounce fires BOTH asks
      });
      // Neither resolved: pending is TRUE, old rows still shown.
      expect(api.firstPagePending).toBe(true);
      expect(api.bottom.hits).toHaveLength(2);

      // The TOP block's new page lands: still pending — the bottom's
      // page zero rides.
      await act(async () => resolvers[2]({ hits: mkHits(60, 5), total: 5 }));
      expect(api.firstPagePending).toBe(true);

      // The bottom's lands too: gone.
      await act(async () => resolvers[3]({ hits: mkHits(70, 6), total: 6 }));
      expect(api.firstPagePending).toBe(false);
      expect(api.bottom.hits).toHaveLength(6); // the new answer replaced old
    } finally {
      vi.useRealTimers();
    }
  });

  it("a STALE landing never clears the newer ask's flag — the old generations disease", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => resolvers[0]({ hits: mkHits(0, 2), total: 2 }));
      await act(async () => resolvers[1]({ hits: mkHits(5, 2), total: 2 }));

      act(() => api.search("auth"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(api.firstPagePending).toBe(true);

      // The PREVIOUS query's page lands late: it must not settle anything.
      await act(async () => resolvers[1]({ hits: mkHits(50, 20), total: 20 }));
      expect(api.firstPagePending).toBe(true);
      expect(api.bottom.hits).toHaveLength(2); // and must not paint

      // The current generation lands: the flag clears.
      await act(async () => resolvers[2]({ hits: mkHits(60, 5), total: 5 }));
      await act(async () => resolvers[3]({ hits: mkHits(70, 6), total: 6 }));
      expect(api.firstPagePending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
