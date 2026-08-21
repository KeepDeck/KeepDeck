// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollPaging } from "./useScrollPaging";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface Metrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

function Probe({
  metrics,
  paging,
  count,
}: {
  metrics: Metrics;
  paging: { hasMore: boolean; loadMore(): void };
  count: number;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const onScroll = useScrollPaging(ref, paging, count);
  return createElement("div", {
    ref: (element: HTMLDivElement | null) => {
      ref.current = element;
      if (element) {
        Object.defineProperties(element, {
          scrollHeight: { configurable: true, value: metrics.scrollHeight },
          scrollTop: { configurable: true, value: metrics.scrollTop },
          clientHeight: { configurable: true, value: metrics.clientHeight },
        });
      }
    },
    onScroll,
  });
}

describe("useScrollPaging", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("loads when the scroll position is near the end", async () => {
    const loadMore = vi.fn();
    await act(async () => {
      root.render(
        createElement(Probe, {
          metrics: { scrollHeight: 1_000, scrollTop: 700, clientHeight: 200 },
          paging: { hasMore: true, loadMore },
          count: 50,
        }),
      );
    });

    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("fills a list shorter than its viewport without waiting for a scroll", async () => {
    const loadMore = vi.fn();
    await act(async () => {
      root.render(
        createElement(Probe, {
          metrics: { scrollHeight: 100, scrollTop: 0, clientHeight: 200 },
          paging: { hasMore: true, loadMore },
          count: 2,
        }),
      );
    });

    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});
