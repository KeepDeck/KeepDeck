// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacesRail, type WorkspaceItem } from "./WorkspacesRail";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const claudeMark = {
  viewBox: "0 0 24 24",
  paths: [{ d: "M0 0h24v24H0z", color: "#D97757" }],
};

const START: WorkspaceItem[] = [
  { id: "a", name: "Alpha", agentCount: 1, agentIcons: [claudeMark] },
  { id: "b", name: "Beta", agentCount: 2, agentIcons: [claudeMark, null] },
  { id: "c", name: "Gamma", agentCount: 3, agentIcons: [] },
  { id: "d", name: "Delta", agentCount: 4, agentIcons: [] },
];

function pointerEvent(
  type: string,
  init: { pointerId?: number; clientX?: number; clientY?: number; button?: number } = {},
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    clientX: { value: init.clientX ?? 10 },
    clientY: { value: init.clientY ?? 0 },
    isPrimary: { value: true },
    pointerId: { value: init.pointerId ?? 1 },
  });
  return event;
}

function rect(top: number): DOMRect {
  return {
    bottom: top + 30,
    height: 30,
    left: 0,
    right: 200,
    top,
    width: 200,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function move(items: WorkspaceItem[], id: string, toIndex: number): WorkspaceItem[] {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0) return items;
  const to = Math.max(0, Math.min(toIndex, items.length - 1));
  if (from === to) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function Harness() {
  const [items, setItems] = useState(START);
  return createElement(WorkspacesRail, {
    workspaces: items,
    activeId: "a",
    onSelect: () => {},
    onAdd: () => {},
    onClose: () => {},
    onRename: () => {},
    onReorder: (id: string, toIndex: number) =>
      setItems((current) => move(current, id, toIndex)),
  });
}

describe("WorkspacesRail drag reorder", () => {
  let host: HTMLDivElement;
  let root: Root;
  let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;
  let originalOffsetTop: PropertyDescriptor | undefined;
  let originalOffsetLeft: PropertyDescriptor | undefined;
  let originalOffsetWidth: PropertyDescriptor | undefined;
  let originalOffsetHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    originalOffsetTop = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetTop",
    );
    originalOffsetLeft = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetLeft",
    );
    originalOffsetWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetWidth",
    );
    originalOffsetHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    HTMLElement.prototype.getBoundingClientRect = function () {
      const element = this as HTMLElement;
      if (element.dataset.wsId && element.parentElement) {
        const items = [
          ...element.parentElement.querySelectorAll<HTMLElement>("[data-ws-id]"),
        ];
        return rect(items.indexOf(element) * 30);
      }
      return rect(0);
    };
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() {
        const element = this as HTMLElement;
        if (!element.dataset.wsId || !element.parentElement) return 0;
        const items = [
          ...element.parentElement.querySelectorAll<HTMLElement>("[data-ws-id]"),
        ];
        return items.indexOf(element) * 30;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
      configurable: true,
      get: () => 0,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.wsId ? 200 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.wsId ? 30 : 0;
      },
    });
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    restorePrototypeProperty("offsetTop", originalOffsetTop);
    restorePrototypeProperty("offsetLeft", originalOffsetLeft);
    restorePrototypeProperty("offsetWidth", originalOffsetWidth);
    restorePrototypeProperty("offsetHeight", originalOffsetHeight);
    document.body.innerHTML = "";
  });

  const order = () =>
    [...document.querySelectorAll<HTMLElement>("[data-ws-id]")].map(
      (item) => item.dataset.wsId,
    );
  const item = (id: string) =>
    document.querySelector<HTMLElement>(`[data-ws-id="${id}"]`)!;

  it("reorders against the current DOM order while the drag is active", () => {
    act(() => root.render(createElement(Harness)));
    expect(order()).toEqual(["a", "b", "c", "d"]);

    act(() => {
      item("b").dispatchEvent(pointerEvent("pointerdown", { clientY: 45 }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector(".rail__ghost")).not.toBeNull();

    act(() =>
      window.dispatchEvent(pointerEvent("pointermove", { clientY: 105 })),
    );
    expect(order()).toEqual(["a", "c", "d", "b"]);

    act(() =>
      window.dispatchEvent(pointerEvent("pointermove", { clientY: 35 })),
    );
    expect(order()).toEqual(["a", "b", "c", "d"]);

    act(() => window.dispatchEvent(pointerEvent("pointerup", { clientY: 35 })));
  });
});

describe("WorkspacesRail unread dots", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("shows a dot only for workspaces with unread notifications", () => {
    act(() => {
      root.render(
        createElement(WorkspacesRail, {
          workspaces: [
            { id: "a", name: "Alpha", agentCount: 1, unread: 2 },
            { id: "b", name: "Beta", agentCount: 2 },
          ],
          activeId: "b",
          onSelect: vi.fn(),
          onAdd: vi.fn(),
          onClose: vi.fn(),
          onRename: vi.fn(),
          onReorder: vi.fn(),
        }),
      );
    });
    const items = [...document.querySelectorAll(".rail__item")];
    expect(items[0].querySelector(".rail__unread")).not.toBeNull();
    expect(items[0].querySelector(".rail__unread")?.getAttribute("title")).toBe(
      "2 unread notifications",
    );
    expect(items[1].querySelector(".rail__unread")).toBeNull();
  });
});

function restorePrototypeProperty(
  name: "offsetTop" | "offsetLeft" | "offsetWidth" | "offsetHeight",
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
}

describe("WorkspacesRail agent marks", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const clusterOf = (wsId: string) =>
    host
      .querySelector(`[data-ws-id="${wsId}"]`)!
      .querySelector(".rail__agents");

  it("draws one glyph per distinct agent — brand mark or neutral fallback", () => {
    const svgs = clusterOf("b")!.querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    const brand = svgs[0].querySelector("path")!;
    expect(brand.getAttribute("d")).toBe(claudeMark.paths[0].d);
    expect(brand.getAttribute("fill")).toBe(claudeMark.paths[0].color);
    // The icon-less second agent gets the neutral prompt, not empty space.
    expect(svgs[1].querySelector("polyline")).not.toBeNull();
  });

  it("renders no cluster at all for a workspace without marks", () => {
    expect(clusterOf("c")).toBeNull();
  });
});
