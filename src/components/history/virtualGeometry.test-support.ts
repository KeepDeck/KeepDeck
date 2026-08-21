// @vitest-environment happy-dom
/**
 * The browser-side geometry the virtualized list needs and happy-dom
 * does not compute: element rects (getBoundingClientRect returns
 * zeros) and a ResizeObserver. This adapter IMITATES THE BROWSER, not
 * the list's logic: the virtualizer still reads whatever sizes the
 * (simulated) layout reports — tests pin the scroll container's height
 * through it, exactly as a real browser would report the laid-out
 * value. No production code reads anything from here.
 */

/** Pins the list scroll container (and everything inside it) to a
 * viewport size. `rowHeight` defaults to 64; pass the ESTIMATE (72)
 * when a test needs measurement to be a no-op (offsets computed from
 * the estimate never shift after the first measure — the stability
 * witnesses need that). Returns a restore function. */
export function pinListViewport(
  height: number,
  width = 800,
  rowHeight = 64,
): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (
    this: Element,
  ): DOMRect {
    const base = original.call(this);
    const el = this as HTMLElement;
    if (el.closest?.(".browser__list") || el.classList?.contains("browser__list")) {
      // Everything inside the list reports the CONTAINER's box as its
      // own: the virtualizer's viewport probe reads the container, and
      // any per-row measurement reads the pinned row height.
      return {
        ...base,
        width,
        height: el.classList?.contains("browser__list") ? height : rowHeight,
        top: 0,
        bottom: height,
        left: 0,
        right: width,
      } as DOMRect;
    }
    return base;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** The minimal observer the virtualizer subscribes to: reports the
 * element's current rect once, then stays silent (tests drive changes
 * by re-render, not by resize). */
export function installResizeObserver(): void {
  const RO = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element): void {
      const r = target.getBoundingClientRect();
      this.cb(
        [
          {
            target,
            contentRect: r,
            borderBoxSize: [
              { inlineSize: r.width, blockSize: r.height },
            ] as unknown as ResizeObserverEntry["borderBoxSize"],
            contentBoxSize: [] as unknown as ResizeObserverEntry["contentBoxSize"],
            devicePixelContentBoxSize: [] as unknown,
            intersectionRect: r,
            toJSON: () => ({}),
          } as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): ResizeObserverEntry[] {
      return [];
    }
  };
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    RO;
}
