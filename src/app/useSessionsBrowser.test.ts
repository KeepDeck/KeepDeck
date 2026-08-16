// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchHit, SearchPage } from "../ipc/history";

const ipc = vi.hoisted(() => ({
  indexSearch: vi.fn<(...args: unknown[]) => Promise<SearchPage>>(),
}));
vi.mock("../ipc/history", () => ({ indexSearch: ipc.indexSearch }));

const scans = vi.hoisted(() => ({
  scanAgentHistories: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));
vi.mock("./historyScan", () => scans);

// The plugin registry the scan draws its sources from — mutable so a test can
// install per-agent history contributions. Shape mirrors the runtime: a
// contribution wraps its `entry`.
const registry = vi.hoisted(() => ({
  agents: [] as Array<{ entry: { id: string; history?: object } }>,
}));
vi.mock("./runtimeContext", () => ({
  useAppRuntime: () => ({
    plugins: { pluginRegistries: { agents: { list: () => registry.agents } } },
  }),
}));

import { useSessionsBrowser } from "./useSessionsBrowser";
import { FIRST_PAGE, NEXT_PAGE } from "./usePagedSessionSearch";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mkHits = (from: number, count: number): SearchHit[] =>
  Array.from({ length: count }, (_, i) => ({
    agent: "claude",
    sessionId: `s-${from + i}`,
    reference: `/store/s-${from + i}`,
    cwd: "/repo",
    title: null,
    transcriptPath: null,
    mtime: 1000 - (from + i),
    snippet: null,
  }));

let api: ReturnType<typeof useSessionsBrowser>;

function Probe() {
  api = useSessionsBrowser();
  return null;
}

describe("useSessionsBrowser paging", () => {
  let root: Root;
  /** Pending indexSearch resolutions, in call order. */
  let resolvers: ((page: SearchPage) => void)[];

  beforeEach(() => {
    resolvers = [];
    registry.agents = [];
    ipc.indexSearch.mockReset();
    ipc.indexSearch.mockImplementation(
      () =>
        new Promise<SearchPage>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    scans.scanAgentHistories.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => act(() => root.unmount()));

  const mount = () => act(() => root.render(createElement(Probe)));

  it("lists page zero once on mount: first page 50, full total exposed", async () => {
    await mount();
    expect(ipc.indexSearch).toHaveBeenCalledExactlyOnceWith("", FIRST_PAGE, 0);
    await act(async () => resolvers[0]({ hits: mkHits(0, 50), total: 123 }));
    expect(api.hits).toHaveLength(50);
    expect(api.total).toBe(123);
    expect(api.hasMore).toBe(true);
  });

  it("loadMore appends the next 20 at the loaded offset; a double-fire is one request", async () => {
    await mount();
    await act(async () => resolvers[0]({ hits: mkHits(0, 50), total: 123 }));

    act(() => {
      api.loadMore();
      api.loadMore(); // in flight — must not double-request
    });
    expect(ipc.indexSearch).toHaveBeenCalledTimes(2);
    expect(ipc.indexSearch).toHaveBeenLastCalledWith("", NEXT_PAGE, 50);

    await act(async () => resolvers[1]({ hits: mkHits(50, 20), total: 123 }));
    expect(api.hits).toHaveLength(70);
    expect(api.hits[50].sessionId).toBe("s-50"); // appended, not replaced
    expect(api.hasMore).toBe(true);
  });

  it("loadMore is a no-op once everything is loaded", async () => {
    await mount();
    await act(async () => resolvers[0]({ hits: mkHits(0, 3), total: 3 }));
    act(() => api.loadMore());
    expect(ipc.indexSearch).toHaveBeenCalledTimes(1);
    expect(api.hasMore).toBe(false);
  });

  it("a page landing after the query changed is dropped — no foreign rows under a new query", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => resolvers[0]({ hits: mkHits(0, 50), total: 123 }));

      act(() => api.loadMore()); // page two, response delayed
      act(() => api.search("auth"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150); // debounce fires
      });
      expect(ipc.indexSearch).toHaveBeenLastCalledWith("auth", FIRST_PAGE, 0);

      // The STALE page-two response lands after the query changed.
      await act(async () => resolvers[1]({ hits: mkHits(50, 20), total: 123 }));
      expect(api.hits).toHaveLength(50); // untouched

      await act(async () => resolvers[2]({ hits: mkHits(0, 5), total: 5 }));
      expect(api.hits).toHaveLength(5);
      expect(api.total).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a scan refresh re-fetches the full loaded span — pages the user walked must not collapse", async () => {
    await mount();
    await act(async () => resolvers[0]({ hits: mkHits(0, 50), total: 123 }));
    act(() => api.loadMore());
    await act(async () => resolvers[1]({ hits: mkHits(50, 20), total: 123 }));
    expect(api.hits).toHaveLength(70);

    await act(async () => api.scan());
    expect(ipc.indexSearch).toHaveBeenLastCalledWith("", 70, 0);
    await act(async () => resolvers[2]({ hits: mkHits(0, 70), total: 124 }));
    expect(api.hits).toHaveLength(70);
    expect(api.total).toBe(124);
  });

  it("scan progress refreshes the listing while the scan is still running", async () => {
    let finish!: () => void;
    scans.scanAgentHistories.mockImplementation(
      (..._args: unknown[]) =>
        new Promise<void>((resolve) => {
          const onProgress = _args[2] as (() => void) | undefined;
          onProgress?.(); // a batch landed mid-scan
          finish = resolve;
        }),
    );
    await mount();
    await act(async () => resolvers[0]({ hits: mkHits(0, 2), total: 2 }));

    act(() => api.scan());
    // The mid-scan progress tick already refreshed — before the scan ended.
    expect(ipc.indexSearch).toHaveBeenCalledTimes(2);
    expect(api.scanning).toBe(true);
    await act(async () => resolvers[1]({ hits: mkHits(0, 30), total: 30 }));
    expect(api.hits).toHaveLength(30);

    await act(async () => finish());
    expect(api.scanning).toBe(false);
  });
});

describe("useSessionsBrowser scan scoping and chaining", () => {
  let root: Root;

  beforeEach(() => {
    ipc.indexSearch.mockReset();
    ipc.indexSearch.mockResolvedValue({ hits: [], total: 0 });
    scans.scanAgentHistories.mockReset();
    scans.scanAgentHistories.mockResolvedValue(undefined);
    registry.agents = [
      { entry: { id: "claude", history: { read: "claude-history" } } },
      { entry: { id: "codex", history: { read: "codex-history" } } },
      { entry: { id: "kimi" } }, // a history-less contribution is never a source
    ];
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => act(() => root.unmount()));

  const mount = () => act(() => root.render(createElement(Probe)));

  const sourcesOf = (call: number) =>
    scans.scanAgentHistories.mock.calls[call][0] as Array<{
      agentId: string;
      history: object;
    }>;

  it("scan(agent) indexes only that agent's store", async () => {
    await mount();
    await act(async () => api.scan("codex"));
    expect(scans.scanAgentHistories).toHaveBeenCalledTimes(1);
    expect(sourcesOf(0)).toEqual([
      { agentId: "codex", history: { read: "codex-history" } },
    ]);
  });

  it("scan() with no agent sweeps every history-bearing contribution", async () => {
    await mount();
    await act(async () => api.scan());
    expect(sourcesOf(0).map((s) => s.agentId)).toEqual(["claude", "codex"]);
  });

  it("the caller's onProgress fires per landed batch and once at settle", async () => {
    let finish!: () => void;
    const onProgress = vi.fn();
    scans.scanAgentHistories.mockImplementation(
      (...args: unknown[]) =>
        new Promise<void>((resolve) => {
          (args[2] as () => void)(); // a batch landed mid-scan
          finish = resolve;
        }),
    );
    await mount();

    act(() => api.scan("claude", onProgress));
    expect(onProgress).toHaveBeenCalledTimes(1); // the batch tick, pre-settle
    await act(async () => finish());
    expect(onProgress).toHaveBeenCalledTimes(2); // + the settle tick
  });

  it("a scan requested mid-scan is chained behind it, not dropped", async () => {
    let finishFirst!: () => void;
    scans.scanAgentHistories.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    await mount();

    act(() => api.scan()); // the full sweep, hangs
    act(() => api.scan("claude")); // narrower request while it runs
    expect(scans.scanAgentHistories).toHaveBeenCalledTimes(1);

    await act(async () => finishFirst());
    // The queued request ran after the sweep settled — same sources it asked
    // for, not silently swallowed by the in-flight guard.
    await act(async () => {});
    expect(scans.scanAgentHistories).toHaveBeenCalledTimes(2);
    expect(sourcesOf(1).map((s) => s.agentId)).toEqual(["claude"]);
    expect(api.scanning).toBe(false);
  });
});
