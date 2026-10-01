// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StripTeam, StripView, WorkspaceMark } from "../../presentation/stripView";
import { WorkspaceStrip } from "./WorkspaceStrip";
import { STRIP_REVEAL_DWELL_MS, STRIP_REVEAL_GRACE_MS } from "./useStripReveal";

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
  teams: [],
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
  onEnterTeam: vi.fn(),
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
    const groups = [...host.querySelectorAll<HTMLElement>("[data-ws-id]")];
    expect(groups.map((m) => m.dataset.wsId)).toEqual(["a", "b", "c", "d"]);
    const marks = groups.map((group) => group.querySelector<HTMLElement>(".strip__mark")!);
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
  const slot = (element: HTMLElement) => {
    // A mark's button sits in its group, which is the list's item.
    const item = element.dataset.wsId ? element : element.classList.contains("strip__mark")
      ? element.closest<HTMLElement>("[data-ws-id]")
      : null;
    return item?.parentElement
      ? [...item.parentElement.querySelectorAll<HTMLElement>("[data-ws-id]")].indexOf(item)
      : -1;
  };

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
  const markEl = (id: string) =>
    document.querySelector<HTMLElement>(`[data-ws-id="${id}"] .strip__mark`)!;

  it("closes an open strip when a hold turns into a drag", () => {
    act(() => root.render(createElement(Harness)));
    const col = document.querySelector(".strip__col")!;
    act(() => {
      col.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
      );
      vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS);
    });
    expect(document.querySelector(".strip--revealed")).not.toBeNull();
    act(() => {
      markEl("b").dispatchEvent(pointerEvent("pointerdown", { clientY: 70 }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector(".strip__ghost")).not.toBeNull();
    expect(document.querySelector(".strip--revealed")).toBeNull();
    // The drop settles (140ms + its 100ms safety) with the pointer still on
    // the column: the strip is SHUT — the drag closed it rather than hiding
    // it for the drag's length — and a fresh rest opens it again, though no
    // pointer ever re-entered.
    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", { clientY: 70 }));
      vi.advanceTimersByTime(240);
    });
    expect(document.querySelector(".strip__ghost")).toBeNull();
    expect(document.querySelector(".strip--revealed")).toBeNull();
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    expect(document.querySelector(".strip--revealed")).not.toBeNull();
  });

  it("stays shut after a drop that ends off the column", () => {
    act(() => root.render(createElement(Harness)));
    const col = document.querySelector(".strip__col")!;
    act(() => {
      col.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
      );
      markEl("b").dispatchEvent(pointerEvent("pointerdown", { clientY: 70 }));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      col.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      );
      window.dispatchEvent(pointerEvent("pointerup", { clientY: 70 }));
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector(".strip--revealed")).toBeNull();
  });

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

describe("WorkspaceStrip opening on approach", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = () =>
    act(() =>
      root.render(createElement(WorkspaceStrip, { view: VIEW, version: null, ...callbacks })),
    );
  const col = () => host.querySelector<HTMLElement>(".strip__col")!;
  const revealed = () => host.querySelector(".strip--revealed") !== null;
  // React derives enter/leave from over/out with a relatedTarget outside.
  const pointer = (type: "enter" | "leave" | "down", target: Element = col()) =>
    act(() => {
      const [name, relatedTarget] =
        type === "enter"
          ? ["pointerover", document.body]
          : type === "leave"
            ? ["pointerout", document.body]
            : ["pointerdown", null];
      target.dispatchEvent(new PointerEvent(name, { bubbles: true, relatedTarget }));
    });

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("names every workspace beside its mark once the pointer rests on the column", () => {
    render();
    const names = [...host.querySelectorAll(".strip__marks .strip__name")].map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    pointer("enter");
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS - 1));
    expect(revealed()).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(revealed()).toBe(true);
  });

  it("closes a grace after the pointer leaves, and stays open if it comes back", () => {
    // Its rows are targets: a pointer overshooting the edge on its way to
    // one must not lose the column.
    render();
    pointer("enter");
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    pointer("leave");
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_GRACE_MS - 1));
    expect(revealed()).toBe(true);
    pointer("enter");
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_GRACE_MS * 2));
    expect(revealed()).toBe(true);
    pointer("leave");
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_GRACE_MS));
    expect(revealed()).toBe(false);
  });

  it("does not open under a press — a click or the start of a hold-to-drag", () => {
    render();
    pointer("enter");
    pointer("down", host.querySelector("[data-ws-id='b'] .strip__mark")!);
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS * 2));
    expect(revealed()).toBe(false);
  });

  it("leaves no pending open or close behind when it goes away", () => {
    render();
    pointer("enter");
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(host);
    render();
    pointer("enter");
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    pointer("leave");
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(host);
  });

  it("keeps the name out of the drag ghost — the ghost is the mark's image", () => {
    render();
    // The face the ghost shares is the tile alone.
    const face = host.querySelector("[data-ws-id='b'] .strip__tile")!;
    expect(face.querySelector(".strip__name")).toBeNull();
  });
});

describe("WorkspaceStrip as the team switcher", () => {
  let host: HTMLDivElement;
  let root: Root;
  const team = (id: string, name: string, extra: Partial<StripTeam> = {}): StripTeam => ({
    id,
    name,
    dot: "none",
    open: false,
    label: name,
    ...extra,
  });
  const TEAMED: StripView = {
    marks: [
      mark("a", "Alpha", {
        active: true,
        teams: [team("t1", "api", { open: true }), team("t2", "web", { dot: "working" })],
      }),
      mark("b", "Beta", { teams: [team("t3", "hwc2", { dot: "waiting" })] }),
      mark("c", "Gamma"),
    ],
    active: { id: "a", name: "Alpha", moveUpTo: null, moveDownTo: 1 },
  };
  const render = () =>
    act(() =>
      root.render(createElement(WorkspaceStrip, { view: TEAMED, version: null, ...callbacks })),
    );
  const col = () => host.querySelector<HTMLElement>(".strip__col")!;
  const revealed = () => host.querySelector(".strip--revealed") !== null;
  const hover = (type: "enter" | "leave") =>
    act(() => {
      col().dispatchEvent(
        new PointerEvent(type === "enter" ? "pointerover" : "pointerout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
  const openStrip = () => {
    hover("enter");
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
  };
  const toggleOf = (id: string) =>
    host.querySelector<HTMLButtonElement>(`[data-ws-id="${id}"] .strip__toggle`);
  const listed = () =>
    [...host.querySelectorAll<HTMLElement>(".strip__teams")].map(
      (list) => list.closest<HTMLElement>("[data-ws-id]")!.dataset.wsId,
    );

  beforeEach(() => {
    for (const fn of Object.values(callbacks)) fn.mockClear();
    vi.useFakeTimers();
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("keeps a shut strip marks only: no team rows, and no toggle in reach", () => {
    render();
    expect(host.querySelector(".strip__teams")).toBeNull();
    expect(toggleOf("a")!.tabIndex).toBe(-1);
    expect(toggleOf("a")!.getAttribute("aria-hidden")).toBe("true");
    // A workspace with no teams has nothing to toggle.
    expect(toggleOf("c")).toBeNull();
  });

  it("opens on the active workspace's teams, the open one current", () => {
    render();
    openStrip();
    expect(listed()).toEqual(["a"]);
    expect(toggleOf("a")!.getAttribute("aria-expanded")).toBe("true");
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".strip__team")];
    expect(rows.map((row) => row.textContent)).toEqual(["api", "web"]);
    expect(rows[0].getAttribute("aria-current")).toBe("true");
    expect(rows[1].querySelector(".team-dot--working")).not.toBeNull();
    // A closed list counts itself; an open one does not.
    expect(toggleOf("b")!.textContent).toBe("1");
    expect(toggleOf("a")!.querySelector(".strip__count")).toBeNull();
  });

  it("lists ONE workspace at a time: a chevron moves the list, again closes it", () => {
    render();
    openStrip();
    act(() => toggleOf("b")!.click());
    expect(listed()).toEqual(["b"]);
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    act(() => toggleOf("b")!.click());
    // Folding away: still drawn, no longer listed...
    expect(toggleOf("b")!.getAttribute("aria-expanded")).toBe("false");
    // ...and gone once its fold has run.
    act(() => void vi.advanceTimersByTime(500));
    expect(listed()).toEqual([]);
  });

  it("goes to a workspace from its mark and shuts until the pointer leaves", () => {
    render();
    openStrip();
    act(() => host.querySelector<HTMLButtonElement>('[data-ws-id="b"] .strip__mark')!.click());
    expect(callbacks.onSelect).toHaveBeenCalledWith("b");
    expect(revealed()).toBe(false);
    // Still over the column: it does not reopen under the pointer...
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS * 4));
    expect(revealed()).toBe(false);
    // ...until the pointer has left and come back.
    hover("leave");
    openStrip();
    expect(revealed()).toBe(true);
  });

  it("enters a team from its row and shuts", () => {
    render();
    openStrip();
    act(() => toggleOf("b")!.click());
    act(() => host.querySelector<HTMLButtonElement>(".strip__team")!.click());
    expect(callbacks.onEnterTeam).toHaveBeenCalledWith("b", "t3");
    expect(revealed()).toBe(false);
  });
});

describe("WorkspaceStrip dragging from the open strip", () => {
  // Geometry that KNOWS the listed teams: a group is its mark (50px) plus
  // its team rows (28px each), stacked down the list. The plain harness
  // above puts every mark at index × 50 and could never see a list drop.
  const MARK = 50;
  const ROW = 28;
  let root: Root;
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;
  const groups = () => [...document.querySelectorAll<HTMLElement>("[data-ws-id]")];
  const heightOf = (group: HTMLElement) =>
    MARK + group.querySelectorAll(".strip__team").length * ROW;
  const topOf = (group: HTMLElement) => {
    let top = 0;
    for (const g of groups()) {
      if (g === group) return top;
      top += heightOf(g);
    }
    return 0;
  };
  const groupOf = (el: HTMLElement) =>
    el.dataset.wsId ? el : el.classList.contains("strip__mark") ? el.closest<HTMLElement>("[data-ws-id]") : null;

  function TeamedHarness() {
    const [marks, setMarks] = useState<WorkspaceMark[]>([
      mark("a", "Alpha", {
        active: true,
        teams: [
          { id: "t1", name: "api", dot: "none", open: true, label: "api" },
          { id: "t2", name: "web", dot: "none", open: false, label: "web" },
        ],
      }),
      mark("b", "Beta"),
      mark("c", "Gamma"),
      mark("d", "Delta"),
    ]);
    return createElement(WorkspaceStrip, {
      view: { marks, active: { id: "a", name: "Alpha", moveUpTo: null, moveDownTo: 1 } },
      version: null,
      ...callbacks,
      onReorder: (id: string, toIndex: number) => setMarks((current) => move(current, id, toIndex)),
    });
  }

  beforeEach(() => {
    for (const fn of Object.values(callbacks)) fn.mockClear();
    vi.useFakeTimers();
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      const group = groupOf(this as HTMLElement);
      const top = group ? topOf(group) : 0;
      return { top, bottom: top + MARK, left: 0, right: 52, width: 52, height: MARK, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    };
    const geometry: Record<string, (el: HTMLElement) => number> = {
      offsetTop: (el) => (el.dataset.wsId ? topOf(el) : 0),
      offsetLeft: () => 0,
      offsetWidth: (el) => (el.dataset.wsId ? 52 : 0),
      offsetHeight: (el) => (el.dataset.wsId ? heightOf(el) : 0),
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

  const order = () => groups().map((g) => g.dataset.wsId);
  const markOf = (id: string) => document.querySelector<HTMLElement>(`[data-ws-id="${id}"] .strip__mark`)!;

  it("holds the grabbed mark under the hand when the drag drops the open list", () => {
    act(() => root.render(createElement(TeamedHarness)));
    act(() => {
      document.querySelector(".strip__col")!.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
      );
      vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS);
    });
    // Alpha lists two teams: Gamma sits at 50 + 56 + 50 = 156.
    expect(document.querySelectorAll(".strip__team")).toHaveLength(2);
    act(() => {
      markOf("c").dispatchEvent(pointerEvent("pointerdown", { clientY: 170 }));
      vi.advanceTimersByTime(300);
    });
    // The drag dropped the list: Gamma rose to 100 under a hand still at 170.
    expect(document.querySelectorAll(".strip__team")).toHaveLength(0);
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientY: 171 })));
    // Read as the column now stands, the hand is still on Gamma: no reorder.
    expect(order()).toEqual(["a", "b", "c", "d"]);
    // A real move past Delta still moves it.
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientY: 230 })));
    expect(order()).toEqual(["a", "b", "d", "c"]);
    act(() => window.dispatchEvent(pointerEvent("pointerup", { clientY: 230 })));
  });
});
