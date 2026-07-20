// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_PAGE,
  NEXT_PAGE,
  usePagedSessionSearch,
  type Page,
  type PagedSearch,
} from "./usePagedSessionSearch";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface Row {
  id: string;
}
const mkRows = (from: number, count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `r-${from + i}` }));

let api: PagedSearch<Row>;
let fetchPage: ReturnType<typeof vi.fn>;

function Probe() {
  api = usePagedSessionSearch<Row>(
    fetchPage as unknown as (
      q: string,
      l: number,
      o: number,
    ) => Promise<Page<Row>>,
  );
  return null;
}

describe("usePagedSessionSearch", () => {
  let root: Root;
  /** Pending fetchPage resolutions, in call order. */
  let resolvers: ((page: Page<Row>) => void)[];

  beforeEach(() => {
    vi.useFakeTimers();
    resolvers = [];
    fetchPage = vi.fn(
      () => new Promise<Page<Row>>((resolve) => resolvers.push(resolve)),
    );
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  const mount = () => act(() => root.render(createElement(Probe)));

  it("does not fetch on its own — the consumer drives the first page", async () => {
    await mount();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(api.rows).toHaveLength(0);
    expect(api.total).toBe(0);
    expect(api.hasMore).toBe(false);
  });

  it("search is debounced, coalesces keystrokes, and exposes rows + total", async () => {
    await mount();
    act(() => {
      api.search("a");
      api.search("ab");
      api.search("abc");
    });
    expect(fetchPage).not.toHaveBeenCalled(); // still within the debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    // Only the last keystroke fires, at page zero.
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith("abc", FIRST_PAGE, 0);
    expect(api.query).toBe("abc");

    await act(async () => resolvers[0]({ rows: mkRows(0, 50), total: 123 }));
    expect(api.rows).toHaveLength(50);
    expect(api.total).toBe(123);
    expect(api.hasMore).toBe(true);
  });

  it("loadMore appends the next page at the loaded offset; a double-fire is one request", async () => {
    await mount();
    act(() => api.refresh());
    expect(fetchPage).toHaveBeenLastCalledWith("", FIRST_PAGE, 0);
    await act(async () => resolvers[0]({ rows: mkRows(0, 50), total: 123 }));

    act(() => {
      api.loadMore();
      api.loadMore(); // in flight — must not double-request
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenLastCalledWith("", NEXT_PAGE, 50);

    await act(async () => resolvers[1]({ rows: mkRows(50, 20), total: 123 }));
    expect(api.rows).toHaveLength(70);
    expect(api.rows[50].id).toBe("r-50"); // appended, not replaced
    expect(api.hasMore).toBe(true);
  });

  it("loadMore is a no-op once everything is loaded", async () => {
    await mount();
    act(() => api.refresh());
    await act(async () => resolvers[0]({ rows: mkRows(0, 3), total: 3 }));
    act(() => api.loadMore());
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(api.hasMore).toBe(false);
  });

  it("drops a page that lands after the query changed — no foreign rows under a new query", async () => {
    await mount();
    act(() => api.refresh());
    await act(async () => resolvers[0]({ rows: mkRows(0, 50), total: 123 }));

    act(() => api.loadMore()); // page two, response delayed (resolvers[1])
    act(() => api.search("auth"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150); // debounce fires (resolvers[2])
    });
    expect(fetchPage).toHaveBeenLastCalledWith("auth", FIRST_PAGE, 0);

    // The STALE page-two response lands after the query changed.
    await act(async () => resolvers[1]({ rows: mkRows(50, 20), total: 123 }));
    expect(api.rows).toHaveLength(50); // untouched

    await act(async () => resolvers[2]({ rows: mkRows(0, 5), total: 5 }));
    expect(api.rows).toHaveLength(5);
    expect(api.total).toBe(5);
  });

  it("refresh re-fetches the full loaded span — pages the user walked must not collapse", async () => {
    await mount();
    act(() => api.refresh());
    await act(async () => resolvers[0]({ rows: mkRows(0, 50), total: 123 }));
    act(() => api.loadMore());
    await act(async () => resolvers[1]({ rows: mkRows(50, 20), total: 123 }));
    expect(api.rows).toHaveLength(70);

    act(() => api.refresh());
    expect(fetchPage).toHaveBeenLastCalledWith("", 70, 0);
    await act(async () => resolvers[2]({ rows: mkRows(0, 70), total: 124 }));
    expect(api.rows).toHaveLength(70);
    expect(api.total).toBe(124);
  });
});
