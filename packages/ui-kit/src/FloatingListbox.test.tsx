// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FloatingListbox,
  calculateFloatingListboxPlacement,
  type FloatingListboxAnchorRect,
} from "./FloatingListbox";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const rect = (
  overrides: Partial<FloatingListboxAnchorRect> = {},
): FloatingListboxAnchorRect => ({
  top: 40,
  right: 208,
  bottom: 72,
  left: 8,
  width: 200,
  ...overrides,
});

describe("calculateFloatingListboxPlacement", () => {
  it("places a fitting list below with the anchor width and a 4px gap", () => {
    expect(
      calculateFloatingListboxPlacement({
        anchorRect: rect(),
        listHeight: 100,
        viewportWidth: 600,
        viewportHeight: 500,
      }),
    ).toEqual({
      side: "below",
      top: 76,
      left: 8,
      width: 200,
      maxHeight: 240,
    });
  });

  it("keeps the list inside the horizontal viewport margin", () => {
    expect(
      calculateFloatingListboxPlacement({
        anchorRect: rect({ left: 450, right: 550, width: 100 }),
        listHeight: 100,
        viewportWidth: 500,
        viewportHeight: 500,
      }).left,
    ).toBe(392);
  });

  it("flips above when the list does not fit below and above has more room", () => {
    expect(
      calculateFloatingListboxPlacement({
        anchorRect: rect({ top: 300, bottom: 332 }),
        listHeight: 200,
        viewportWidth: 600,
        viewportHeight: 400,
      }),
    ).toEqual({
      side: "above",
      top: 96,
      left: 8,
      width: 200,
      maxHeight: 240,
    });
  });

  it("caps and scrolls the list within the larger side when neither side fits", () => {
    expect(
      calculateFloatingListboxPlacement({
        anchorRect: rect({ top: 150, bottom: 182 }),
        listHeight: 500,
        viewportWidth: 600,
        viewportHeight: 300,
      }),
    ).toEqual({
      side: "above",
      top: 8,
      left: 8,
      width: 200,
      maxHeight: 138,
    });
  });

  it("uses actual content height when deciding whether below is sufficient", () => {
    expect(
      calculateFloatingListboxPlacement({
        anchorRect: rect({ top: 130, bottom: 162 }),
        listHeight: 40,
        viewportWidth: 600,
        viewportHeight: 220,
      }).side,
    ).toBe("below");
  });
});

describe("FloatingListbox", () => {
  let host: HTMLElement;
  let anchor: HTMLElement;
  let root: Root | null;
  let anchorRect: FloatingListboxAnchorRect;
  let resizeCallback: ResizeObserverCallback = () => {};
  let observe: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;

  const mount = (
    listRef?: (node: HTMLUListElement | null) => void | (() => void),
  ) => {
    const setListRef = (node: HTMLUListElement | null) => {
      if (node) {
        Object.defineProperty(node, "scrollHeight", {
          configurable: true,
          value: 180,
        });
      }
      return listRef?.(node);
    };
    act(() => {
      root!.render(
        createElement(
          FloatingListbox,
          {
            anchorRef: { current: anchor },
            listRef: setListRef,
            id: "branches",
            "aria-label": "Branches",
          },
          createElement("li", null, "main"),
        ),
      );
    });
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    Object.defineProperties(document.documentElement, {
      clientWidth: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 500 },
    });

    host = document.body.appendChild(document.createElement("div"));
    anchor = document.body.appendChild(document.createElement("button"));
    anchorRect = rect({ top: 100, bottom: 132, left: 40, right: 220, width: 180 });
    anchor.getBoundingClientRect = () =>
      ({
        ...anchorRect,
        x: anchorRect.left,
        y: anchorRect.top,
        height: anchorRect.bottom - anchorRect.top,
        toJSON: () => ({}),
      }) as DOMRect;

    observe = vi.fn();
    disconnect = vi.fn();
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    root = createRoot(host);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document.documentElement, "clientWidth");
    Reflect.deleteProperty(document.documentElement, "clientHeight");
  });

  it("portals a semantic list layer to body and exposes its list ref", () => {
    let exposed: HTMLUListElement | null = null;
    mount((node) => {
      exposed = node;
    });

    const list = document.querySelector<HTMLUListElement>("#branches")!;
    expect(exposed).toBe(list);
    expect(list.getAttribute("role")).toBe("listbox");
    expect(list.getAttribute("aria-label")).toBe("Branches");
    expect(list.classList.contains("dropdown__menu--floating")).toBe(true);
    expect(host.contains(list)).toBe(false);
    expect(list.parentElement?.className).toBe("dropdown__layer");
    expect(list.parentElement?.parentElement).toBe(document.body);
    expect(list.parentElement?.style.zIndex).toBe("90");
    expect(list.style.top).toBe("136px");
    expect(list.style.left).toBe("40px");
    expect(list.style.width).toBe("180px");
  });

  it("keeps a menu inside its existing overlay stacking context", () => {
    const overlay = document.body.appendChild(document.createElement("div"));
    overlay.className = "modal-overlay";
    overlay.appendChild(anchor);
    mount();

    const layer = document.querySelector<HTMLElement>(".dropdown__layer")!;
    expect(layer.parentElement).toBe(overlay);
    expect(layer.style.zIndex).toBe("1");
  });

  it("honors a React 19 callback ref's cleanup", () => {
    const cleanup = vi.fn();
    const externalRef = vi.fn((node: HTMLUListElement | null) =>
      node ? cleanup : undefined,
    );
    mount(externalRef);

    act(() => root!.unmount());
    root = null;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(externalRef).toHaveBeenCalledTimes(1);
  });

  it("repositions on captured ancestor scroll and window resize", () => {
    mount();
    const list = document.querySelector<HTMLUListElement>("#branches")!;

    anchorRect = rect({
      top: 300,
      bottom: 332,
      left: 40,
      right: 220,
      width: 180,
    });
    act(() => anchor.dispatchEvent(new Event("scroll")));
    expect(list.style.top).toBe("116px");

    anchorRect = rect({
      top: 100,
      bottom: 132,
      left: 400,
      right: 580,
      width: 180,
    });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(list.style.left).toBe("312px");
  });

  it("observes both elements, recomputes their geometry, and disconnects", () => {
    mount();
    const list = document.querySelector<HTMLUListElement>("#branches")!;
    expect(observe).toHaveBeenCalledWith(anchor);
    expect(observe).toHaveBeenCalledWith(list);

    anchorRect = rect({
      top: 200,
      bottom: 232,
      left: 70,
      right: 250,
      width: 180,
    });
    act(() => resizeCallback([], {} as ResizeObserver));
    expect(list.style.top).toBe("236px");
    expect(list.style.left).toBe("70px");

    act(() => root!.unmount());
    root = null;
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
