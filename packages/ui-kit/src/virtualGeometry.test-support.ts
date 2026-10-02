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
  // The container's scroll extent: its viewport, and the content it
  // scrolls over — the spacer's height. happy-dom answers 0 for both, and
  // the virtualizer clamps every offset it hands out (a reveal's
  // scrollToIndex among them) to scrollHeight - clientHeight: an offset
  // of 0 for every row, and a list flung to the top.
  // Each on the prototype happy-dom declares it on — clientHeight on
  // HTMLElement, scrollHeight on Element: a getter on Element.prototype
  // is shadowed by HTMLElement's own, and the pin read 0 there unseen
  // (the virtualizer's furthest scroll then ran to the content's full
  // height, and nothing near the end was ever clamped as a browser does).
  const scrolls = {
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
  };
  const content = (el: Element) =>
    Math.max(height, Number.parseFloat((el.firstElementChild as HTMLElement | null)?.style.height ?? "") || 0);
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      return this.classList?.contains(list) ? height : (scrolls.clientHeight?.get?.call(this) ?? 0);
    },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      return this.classList?.contains(list) ? content(this) : (scrolls.scrollHeight?.get?.call(this) ?? 0);
    },
  });
  return () => {
    Element.prototype.getBoundingClientRect = original;
    for (const [name, descriptor] of Object.entries(offsets)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
    for (const [name, descriptor] of Object.entries(scrolls)) {
      const proto = name === "clientHeight" ? HTMLElement.prototype : Element.prototype;
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[name];
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
