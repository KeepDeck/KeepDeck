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

/** Pins one list's scroll container (and everything inside it) to a
 * viewport size. `list` is the container's class — a second virtualized
 * list arrived and the selector stopped being a property of this file.
 * `rowHeight` defaults to 64; pass the ESTIMATE when a test needs
 * measurement to be a no-op (offsets computed from the estimate never
 * shift after the first measure — the stability witnesses need that).
 * Returns a restore function.
 *
 * Both of the browser's answers are pinned, because the virtualizer asks
 * both: the rect (its viewport probe and the observer entries) and the
 * element's `offsetHeight`/`offsetWidth`, which it reads for a row whose
 * observer entry has not arrived and whose size it has not cached — and
 * happy-dom answers 0 there, which a virtualizer takes as "this row is
 * zero tall" and mounts the pile. */
export function pinListViewport(
  list: string,
  height: number,
  width = 800,
  rowHeight = 64,
): () => void {
  const inList = (el: HTMLElement) =>
    Boolean(el.closest?.(`.${list}`) || el.classList?.contains(list));
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (
    this: Element,
  ): DOMRect {
    const base = original.call(this);
    const el = this as HTMLElement;
    if (inList(el)) {
      // Everything inside the list reports the CONTAINER's box as its
      // own: the virtualizer's viewport probe reads the container, and
      // any per-row measurement reads the pinned row height.
      return {
        ...base,
        width,
        height: el.classList?.contains(list) ? height : rowHeight,
        top: 0,
        bottom: height,
        left: 0,
        right: width,
      } as DOMRect;
    }
    return base;
  };
  const offsets = {
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return inList(this)
        ? this.getBoundingClientRect().height
        : (offsets.offsetHeight?.get?.call(this) ?? 0);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return inList(this)
        ? this.getBoundingClientRect().width
        : (offsets.offsetWidth?.get?.call(this) ?? 0);
    },
  });
  return () => {
    Element.prototype.getBoundingClientRect = original;
    for (const [name, descriptor] of Object.entries(offsets)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
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
