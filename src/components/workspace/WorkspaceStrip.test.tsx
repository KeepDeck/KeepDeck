// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StripView, WorkspaceMark } from "../../presentation/stripView";
import { WorkspaceStrip } from "./WorkspaceStrip";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mark = (id: string, name: string, extra: Partial<WorkspaceMark> = {}): WorkspaceMark => ({
  id,
  name,
  initials: name.slice(0, 2),
  active: false,
  dot: null,
  label: name,
  ...extra,
});

const VIEW: StripView = {
  marks: [
    mark("a", "Alpha", { active: true }),
    mark("b", "Beta", { dot: "waiting", label: "Beta — someone needs you" }),
    mark("c", "Gamma"),
    mark("d", "Delta"),
  ],
  active: { id: "a", name: "Alpha", moveUpTo: null, moveDownTo: 1 },
};

const callbacks = {
  onSelect: vi.fn(),
  onAdd: vi.fn(),
  onReorder: vi.fn(),
};

describe("WorkspaceStrip", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    for (const fn of Object.values(callbacks)) fn.mockClear();
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  const render = (props: Record<string, unknown> = {}) =>
    act(() =>
      root.render(
        createElement(WorkspaceStrip, {
          view: VIEW,
          version: null,
          ...callbacks,
          ...props,
        }),
      ),
    );
  const byLabel = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it("draws a mark per workspace, the active one marked, a dot only where it is earned", () => {
    render();
    const marks = [...host.querySelectorAll<HTMLElement>("[data-ws-id]")];
    expect(marks.map((m) => m.dataset.wsId)).toEqual(["a", "b", "c", "d"]);
    expect(marks[0].classList.contains("strip__mark--active")).toBe(true);
    expect(marks[0].getAttribute("aria-current")).toBe("true");
    expect(marks[1].querySelector(".strip__dot")?.className).toBe("strip__dot strip__dot--waiting");
    expect(marks[1].getAttribute("aria-label")).toBe("Beta — someone needs you");
    expect(marks[2].querySelector(".strip__dot")).toBeNull();
    act(() => marks[2].click());
    expect(callbacks.onSelect).toHaveBeenCalledWith("c");
  });

  it("pins «+» above the marks, outside the list that scrolls", () => {
    render();
    const add = byLabel("New workspace")!;
    expect(add.closest(".strip__marks")).toBeNull();
    act(() => add.click());
    expect(callbacks.onAdd).toHaveBeenCalledOnce();
  });

  it("signs the strip with the build, and stays silent without one", () => {
    render({ version: "0.28.0" });
    expect(host.querySelector(".strip__foot")?.textContent).toBe("0.28.0");
    render({ version: null });
    expect(host.querySelector(".strip__foot")).toBeNull();
  });
});

function pointerEvent(
  type: string,
  init: { clientY?: number; button?: number } = {},
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    clientX: { value: 10 },
    clientY: { value: init.clientY ?? 0 },
    isPrimary: { value: true },
    pointerId: { value: 1 },
  });
  return event;
}

const MARK_HEIGHT = 50;

function move<T extends { id: string }>(items: readonly T[], id: string, toIndex: number): T[] {
  const next = items.slice();
  const from = next.findIndex((item) => item.id === id);
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved);
  return next;
}

function Harness() {
  const [marks, setMarks] = useState(VIEW.marks);
  return createElement(WorkspaceStrip, {
    view: { ...VIEW, marks },
    version: null,
    ...callbacks,
    onReorder: (id: string, toIndex: number) => setMarks((current) => move(current, id, toIndex)),
  });
}

describe("WorkspaceStrip drag reorder", () => {
  let root: Root;
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;

  /** Each mark's index in its list, or -1 for anything else. */
  const slot = (element: HTMLElement) =>
    element.dataset.wsId && element.parentElement
      ? [...element.parentElement.querySelectorAll<HTMLElement>("[data-ws-id]")].indexOf(element)
      : -1;

  beforeEach(() => {
    vi.useFakeTimers();
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      const top = Math.max(0, slot(this as HTMLElement)) * MARK_HEIGHT;
      return { top, bottom: top + MARK_HEIGHT, left: 0, right: 52, width: 52, height: MARK_HEIGHT, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    };
    const geometry: Record<string, (el: HTMLElement) => number> = {
      offsetTop: (el) => Math.max(0, slot(el)) * MARK_HEIGHT,
      offsetLeft: () => 0,
      offsetWidth: (el) => (el.dataset.wsId ? 52 : 0),
      offsetHeight: (el) => (el.dataset.wsId ? MARK_HEIGHT : 0),
    };
    for (const [name, get] of Object.entries(geometry)) {
      saved[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get() {
          return get(this as HTMLElement);
        },
      });
    }
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });

  afterEach(() => {
    act(() => root.unmount());
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
    document.body.innerHTML = "";
  });

  const order = () =>
    [...document.querySelectorAll<HTMLElement>("[data-ws-id]")].map((m) => m.dataset.wsId);
  const markEl = (id: string) => document.querySelector<HTMLElement>(`[data-ws-id="${id}"]`)!;

  it("moves a held mark through the column, its ghost wearing its face", () => {
    act(() => root.render(createElement(Harness)));
    act(() => {
      markEl("b").dispatchEvent(pointerEvent("pointerdown", { clientY: 70 }));
      vi.advanceTimersByTime(300);
    });
    // The ghost is the mark's image: its letters and its dot.
    const ghost = document.querySelector(".strip__ghost")!;
    expect(ghost.querySelector(".strip__tile")?.textContent).toBe("Be");
    expect(ghost.querySelector(".strip__dot--waiting")).not.toBeNull();

    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientY: 175 })));
    expect(order()).toEqual(["a", "c", "d", "b"]);
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientY: 60 })));
    expect(order()).toEqual(["a", "b", "c", "d"]);
    act(() => window.dispatchEvent(pointerEvent("pointerup", { clientY: 60 })));
  });

  it("selects on a plain click, without starting a drag", () => {
    act(() => root.render(createElement(Harness)));
    act(() => {
      markEl("c").dispatchEvent(pointerEvent("pointerdown", { clientY: 110 }));
      window.dispatchEvent(pointerEvent("pointerup", { clientY: 110 }));
      markEl("c").click();
    });
    expect(document.querySelector(".strip__ghost")).toBeNull();
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("c");
  });
});

describe("WorkspaceStrip «+»", () => {
  it("draws its plus rather than typing it, so it sits in the tile's middle", () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() =>
      root.render(
        createElement(WorkspaceStrip, { view: VIEW, version: null, ...callbacks }),
      ),
    );
    const tile = document.querySelector('button[aria-label="New workspace"] .strip__tile')!;
    expect(tile.querySelector("svg")).not.toBeNull();
    expect(tile.textContent).toBe("");
    act(() => root.unmount());
  });
});
