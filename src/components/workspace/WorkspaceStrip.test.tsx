// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StripTeam, StripView, WorkspaceMark } from "../../presentation/stripView";
import { WorkspaceStrip } from "./WorkspaceStrip";
import {
  STRIP_FOCUS_ASK_MS,
  STRIP_POINTER_CHECK_MS,
  STRIP_REVEAL_DWELL_MS,
  STRIP_REVEAL_GRACE_MS,
} from "../../presentation/stripReveal";

// Where the OS says the pointer is — in the window unless a test moves it.
// `answer`, when set, is the one the next ask gets — a test holds it to
// answer late.
// `point` is where it says the pointer rests on the window — off it unless
// a test puts it somewhere.
const os = vi.hoisted(() => ({
  inWindow: true as boolean | null,
  asks: 0,
  answer: null as Promise<boolean | null> | null,
  point: null as { x: number; y: number; pressed: boolean } | null,
  pointAnswer: null as Promise<{ x: number; y: number; pressed: boolean } | null> | null,
}));
vi.mock("../../ipc/window", () => ({
  pointerInWindow: () => {
    os.asks += 1;
    return os.answer ?? Promise.resolve(os.inWindow);
  },
  pointerOnWindow: () => os.pointAnswer ?? Promise.resolve(os.point),
}));

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
    os.asks = 0;
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
    // Not "false" on every other mark: no attribute at all.
    expect(marks[1].hasAttribute("aria-current")).toBe(false);
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

  it("holds an open strip open through a drag, and after a drop on the column", () => {
    // Shutting it would drop every team list and jump the marks under the
    // hand; it holds as it is instead, however far the pointer goes.
    act(() => root.render(createElement(Harness)));
    const col = document.querySelector(".strip__col")!;
    act(() => {
      col.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
      );
    });
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    act(() => {
      markEl("b").dispatchEvent(pointerEvent("pointerdown", { clientY: 70 }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector(".strip__ghost")).not.toBeNull();
    // The hand travels off the column mid-drag: still open.
    act(() => {
      col.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
      vi.advanceTimersByTime(STRIP_REVEAL_GRACE_MS * 3);
    });
    expect(document.querySelector(".strip--revealed")).not.toBeNull();
    // Back over it and dropped: it stays.
    act(() => {
      col.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      window.dispatchEvent(pointerEvent("pointerup", { clientY: 70 }));
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector(".strip__ghost")).toBeNull();
    expect(document.querySelector(".strip--revealed")).not.toBeNull();
  });

  it("shuts an open strip a grace after a drop that ends off the column", () => {
    act(() => root.render(createElement(Harness)));
    const col = document.querySelector(".strip__col")!;
    act(() => {
      col.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
      );
    });
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    act(() => {
      markEl("b").dispatchEvent(pointerEvent("pointerdown", { clientY: 70 }));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      col.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
      window.dispatchEvent(pointerEvent("pointerup", { clientY: 70 }));
    });
    // The ghost settles into its slot (140ms + 100ms safety); the drag ends
    // there, and the grace runs from then.
    act(() => void vi.advanceTimersByTime(240));
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_GRACE_MS - 1));
    expect(document.querySelector(".strip--revealed")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(document.querySelector(".strip--revealed")).toBeNull();
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
    // The strip was shut: the ghost is the mark alone, no name.
    expect(ghost.querySelector(".strip__name")).toBeNull();

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
    // The grace, and the open strip's asking the OS where the pointer is.
    expect(vi.getTimerCount()).toBe(2);
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
    os.asks = 0;
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
    // Inert, not merely skipped by Tab: no click, no script, no reader
    // reaches a control past the shut edge.
    expect(toggleOf("a")!.inert).toBe(true);
    // A workspace with no teams has nothing to toggle.
    expect(toggleOf("c")).toBeNull();
  });

  it("opens on the active workspace's teams, the open one current", () => {
    render();
    openStrip();
    expect(listed()).toEqual(["a"]);
    expect(toggleOf("a")!.getAttribute("aria-expanded")).toBe("true");
    expect(toggleOf("a")!.inert).toBe(false);
    expect(host.querySelector(".strip__teams")!.getAttribute("aria-label")).toBe("Alpha");
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".strip__team")];
    expect(rows.map((row) => row.textContent)).toEqual(["api", "web"]);
    expect(rows[0].getAttribute("aria-current")).toBe("true");
    expect(rows[1].querySelector(".team-dot--working")).not.toBeNull();
    // A closed list counts itself; an open one does not.
    expect(toggleOf("b")!.textContent).toBe("1");
    expect(toggleOf("a")!.querySelector(".strip__count")).toBeNull();
  });

  it("opens and folds lists freely, any number at once", () => {
    render();
    openStrip();
    act(() => toggleOf("b")!.click());
    expect(listed()).toEqual(["a", "b"]);
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    act(() => toggleOf("a")!.click());
    // Folding away: still drawn, no longer listed...
    expect(toggleOf("a")!.getAttribute("aria-expanded")).toBe("false");
    // ...and gone once its fold has run; Beta stays.
    act(() => void vi.advanceTimersByTime(500));
    expect(listed()).toEqual(["b"]);
  });

  it("opens again with the lists the person kept open", () => {
    render();
    openStrip();
    act(() => toggleOf("b")!.click());
    hover("leave");
    // The grace shuts it; then the folds run.
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_GRACE_MS));
    act(() => void vi.advanceTimersByTime(1000));
    expect(listed()).toEqual([]);
    openStrip();
    expect(listed()).toEqual(["a", "b"]);
  });

  it("reopens a list caught mid-fold and keeps it open — no stale fold lands", () => {
    render();
    openStrip();
    act(() => toggleOf("a")!.click()); // fold Alpha
    act(() => toggleOf("a")!.click()); // and back, before the fold ends
    act(() => void vi.advanceTimersByTime(500));
    // The old fold's frames must not settle it away under the new open.
    expect(listed()).toEqual(["a"]);
    expect(toggleOf("a")!.getAttribute("aria-expanded")).toBe("true");
  });

  const graced = () => act(() => void vi.advanceTimersByTime(STRIP_REVEAL_GRACE_MS));
  /** A pointer event the document sees, on `target` (default: the stage
   * — anything that is not the column). */
  const pointer = (type: string, target: EventTarget = document.body) =>
    act(() => void target.dispatchEvent(new PointerEvent(type, { bubbles: true })));

  it("goes to a workspace from its mark and stays open for the next click — the pointer leaving shuts it", () => {
    render();
    openStrip();
    act(() => host.querySelector<HTMLButtonElement>('[data-ws-id="b"] .strip__mark')!.click());
    expect(callbacks.onSelect).toHaveBeenCalledWith("b");
    expect(revealed()).toBe(true);
    hover("leave");
    graced();
    expect(revealed()).toBe(false);
  });

  it("enters a team from its row and stays open — clicking through teams needs no reopening", () => {
    render();
    openStrip();
    act(() => toggleOf("b")!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-ws-id="b"] .strip__team')!.click());
    expect(callbacks.onEnterTeam).toHaveBeenCalledWith("b", "t3");
    expect(revealed()).toBe(true);
  });

  it("opens after a press on it lets go — a press cancels the rest, not the opening", () => {
    render();
    hover("enter");
    pointer("pointerdown", col());
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    expect(revealed()).toBe(false);
    pointer("pointerup", col());
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    expect(revealed()).toBe(true);
  });

  it("opens after a press that was cancelled, not let go — a cancel is a let-go too", () => {
    render();
    hover("enter");
    pointer("pointerdown", col());
    pointer("pointercancel", col());
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    expect(revealed()).toBe(true);
  });

  it("opens once a move shows no button held, though the let-go was never heard", () => {
    render();
    hover("enter");
    pointer("pointerdown", col());
    // The up went elsewhere (outside the window): the next move says no
    // button is held.
    pointer("pointermove", col());
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    expect(revealed()).toBe(true);
  });

  it("shuts on a press off it", () => {
    render();
    openStrip();
    pointer("pointerdown");
    graced();
    expect(revealed()).toBe(false);
  });

  it("lets go of every listener it set, the same way it set it", () => {
    // Each registration as (target, type, listener, capture): a removal
    // with another listener or another phase leaves the listener live.
    type Entry = [EventTarget, string, unknown, boolean];
    const key = ([t, type, fn, capture]: Entry) => [t, type, fn, capture];
    const added: Entry[] = [];
    const removed: Entry[] = [];
    const capture = (o: unknown) => (typeof o === "boolean" ? o : Boolean((o as { capture?: boolean })?.capture));
    const spies = [document, window, document.documentElement].flatMap((target) => {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      return [
        vi.spyOn(target, "addEventListener").mockImplementation((type: string, fn: unknown, o?: unknown) => {
          added.push([target, type, fn, capture(o)]);
          add(type, fn as EventListener, o as AddEventListenerOptions);
        }),
        vi.spyOn(target, "removeEventListener").mockImplementation((type: string, fn: unknown, o?: unknown) => {
          removed.push([target, type, fn, capture(o)]);
          remove(type, fn as EventListener, o as EventListenerOptions);
        }),
      ];
    });
    try {
      render();
      const ours = new Set(["pointerover", "pointermove", "pointerout", "pointerdown", "pointerup", "pointercancel", "mouseleave", "blur", "focus", "visibilitychange"]);
      const set = added.filter(([, type]) => ours.has(type));
      expect(new Set(set.map(([, type]) => type))).toEqual(ours);
      act(() => root.unmount());
      root = createRoot(host);
      for (const entry of set) {
        expect(removed.some((r) => key(r).every((part, i) => part === key(entry)[i]))).toBe(true);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("does not open while a button is held across it — a selection or a drag from the stage", () => {
    render();
    act(() => void col().dispatchEvent(new PointerEvent("pointerover", { bubbles: true, buttons: 1 })));
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS * 2));
    expect(revealed()).toBe(false);
  });

  it("asks the OS only while it is open and no drag holds it", async () => {
    render();
    await act(async () => void vi.advanceTimersByTime(STRIP_POINTER_CHECK_MS * 3));
    expect(os.asks).toBe(0);
    openStrip();
    await act(async () => void vi.advanceTimersByTime(STRIP_POINTER_CHECK_MS));
    expect(os.asks).toBe(1);
    hover("leave");
    graced();
    const asked = os.asks;
    await act(async () => void vi.advanceTimersByTime(STRIP_POINTER_CHECK_MS * 3));
    expect(os.asks).toBe(asked);
  });

  it("stops asking where the OS cannot say", async () => {
    render();
    openStrip();
    os.inWindow = null;
    try {
      await act(async () => void vi.advanceTimersByTime(STRIP_POINTER_CHECK_MS));
      const asked = os.asks;
      await act(async () => void vi.advanceTimersByTime(STRIP_POINTER_CHECK_MS * 3));
      expect(os.asks).toBe(asked);
      expect(revealed()).toBe(true);
    } finally {
      os.inWindow = true;
    }
  });

  it("drops an OS answer the page has outrun — the pointer came back while it was asked", async () => {
    render();
    openStrip();
    let answer!: (inWindow: boolean) => void;
    os.answer = new Promise((resolve) => (answer = resolve));
    try {
      act(() => void vi.advanceTimersByTime(STRIP_POINTER_CHECK_MS));
      // Asked while away; the page hears the pointer on the column, then
      // the late "outside" arrives.
      pointer("pointermove", col());
      await act(async () => answer(false));
      graced();
      expect(revealed()).toBe(true);
    } finally {
      os.answer = null;
    }
  });

  it("opens on a move over it though no crossing was heard", () => {
    render();
    pointer("pointermove", col());
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    expect(revealed()).toBe(true);
  });

  it("shuts on the next move off it though no leave was heard — a dialog opened over the pointer", () => {
    render();
    openStrip();
    // The pointer is on something that is not the column: an overlay over
    // it, or the stage — the topmost thing under the pointer decides.
    pointer("pointermove");
    graced();
    expect(revealed()).toBe(false);
  });

  it("shuts when the OS says the pointer left the window though the page heard nothing", async () => {
    render();
    openStrip();
    os.inWindow = false;
    try {
      await act(async () => void vi.advanceTimersByTime(STRIP_POINTER_CHECK_MS));
      graced();
      expect(revealed()).toBe(false);
    } finally {
      os.inWindow = true;
    }
  });

  it("stays open while the OS has the pointer in the window", async () => {
    render();
    openStrip();
    await act(async () => void vi.advanceTimersByTime(STRIP_POINTER_CHECK_MS * 5));
    expect(revealed()).toBe(true);
  });

  describe("a window coming to the front under a pointer that has not moved", () => {
    // happy-dom lays nothing out: what is "under" the OS's point is said here.
    let under: Element | null;
    beforeEach(() => {
      under = null;
      vi.spyOn(document, "elementFromPoint").mockImplementation(() => under);
    });
    afterEach(() => {
      os.point = null;
      os.pointAnswer = null;
      vi.restoreAllMocks();
    });
    const focus = () => act(async () => void window.dispatchEvent(new Event("focus")));

    it("opens after the rest when the OS finds the pointer on the strip — no move needed", async () => {
      render();
      os.point = { x: 10, y: 40, pressed: false };
      under = col().querySelector(".strip__mark") ?? col();
      await focus();
      expect(document.elementFromPoint).toHaveBeenCalledWith(10, 40);
      act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
      expect(revealed()).toBe(true);
    });

    it("stays shut when the pointer rests elsewhere on the window, or off it", async () => {
      render();
      os.point = { x: 600, y: 40, pressed: false };
      under = document.body;
      await focus();
      os.point = null;
      await focus();
      act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS * 2));
      expect(revealed()).toBe(false);
    });

    it("opens once the click that brought the window forward is let go — heard by the page only as a pointerover with the button held", async () => {
      render();
      os.point = { x: 10, y: 40, pressed: true };
      under = col();
      await focus();
      // The activating click, as WKWebView delivers it: an over, button held — no down, never an up.
      act(() => void col().dispatchEvent(new PointerEvent("pointerover", { bubbles: true, buttons: 1 })));
      await act(async () => void vi.advanceTimersByTime(STRIP_FOCUS_ASK_MS * 3));
      expect(revealed()).toBe(false);
      os.point = { x: 10, y: 40, pressed: false };
      await act(async () => void vi.advanceTimersByTime(STRIP_FOCUS_ASK_MS));
      act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
      expect(revealed()).toBe(true);
    });

    it("stops asking once the window loses focus", async () => {
      render();
      os.point = { x: 10, y: 40, pressed: true };
      under = col();
      await focus();
      act(() => void window.dispatchEvent(new Event("blur")));
      os.point = { x: 10, y: 40, pressed: false };
      await act(async () => void vi.advanceTimersByTime(STRIP_FOCUS_ASK_MS * 5));
      act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS * 2));
      expect(revealed()).toBe(false);
    });

    it("drops an answer that lands after the window lost focus again", async () => {
      render();
      let answer!: (point: { x: number; y: number; pressed: boolean }) => void;
      os.pointAnswer = new Promise((resolve) => (answer = resolve));
      under = col();
      await focus();
      act(() => void window.dispatchEvent(new Event("blur")));
      await act(async () => answer({ x: 10, y: 40, pressed: false }));
      act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS * 2));
      expect(revealed()).toBe(false);
    });

    it("drops an answer the page has outrun — the pointer moved off the strip while the OS was asked", async () => {
      render();
      let answer!: (point: { x: number; y: number; pressed: boolean }) => void;
      os.pointAnswer = new Promise((resolve) => (answer = resolve));
      under = col();
      await focus();
      pointer("pointermove");
      await act(async () => answer({ x: 10, y: 40, pressed: false }));
      act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS * 2));
      expect(revealed()).toBe(false);
    });
  });

  it("shuts when the pointer leaves the window, the window loses focus, or the page hides", () => {
    for (const away of [
      () => document.documentElement.dispatchEvent(new MouseEvent("mouseleave")),
      () => window.dispatchEvent(new Event("blur")),
      () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        try {
          document.dispatchEvent(new Event("visibilitychange"));
        } finally {
          delete (document as unknown as { visibilityState?: string }).visibilityState;
        }
      },
    ]) {
      render();
      openStrip();
      act(away);
      graced();
      expect(revealed()).toBe(false);
      act(() => root.unmount());
      root = createRoot(host);
    }
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
    os.asks = 0;
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

  it("carries the name with the mark when the strip is open", () => {
    act(() => root.render(createElement(TeamedHarness)));
    act(() => {
      document.querySelector(".strip__col")!.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
      );
    });
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    act(() => {
      markOf("b").dispatchEvent(pointerEvent("pointerdown", { clientY: 120 }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector(".strip__ghost .strip__name")?.textContent).toBe("Beta");
    act(() => window.dispatchEvent(pointerEvent("pointerup", { clientY: 120 })));
  });

  it("carries a dragged workspace as its mark alone, its list back where it lands", () => {
    act(() => root.render(createElement(TeamedHarness)));
    act(() => {
      document.querySelector(".strip__col")!.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
      );
    });
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    const alphaRows = () => document.querySelectorAll('[data-ws-id="a"] .strip__team').length;
    expect(alphaRows()).toBe(2);
    act(() => {
      markOf("a").dispatchEvent(pointerEvent("pointerdown", { clientY: 20 }));
      vi.advanceTimersByTime(300);
    });
    // Its list folds away under the drag — still drawn as it folds...
    expect(alphaRows()).toBe(2);
    act(() => void vi.advanceTimersByTime(500));
    // ...and gone once folded: no hole the height of Alpha's teams.
    expect(alphaRows()).toBe(0);
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientY: 120 })));
    expect(order()).toEqual(["b", "c", "a", "d"]);
    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", { clientY: 120 }));
      vi.advanceTimersByTime(1000);
    });
    // Landed: its list is open again, in its new place.
    expect(alphaRows()).toBe(2);
  });

  it("drags from the open strip with its lists in place: nothing moves under the hand", () => {
    act(() => root.render(createElement(TeamedHarness)));
    act(() => {
      document.querySelector(".strip__col")!.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
      );
    });
    act(() => void vi.advanceTimersByTime(STRIP_REVEAL_DWELL_MS));
    // Alpha lists two teams: Gamma sits at 50 + 56 + 50 = 156.
    act(() => {
      markOf("c").dispatchEvent(pointerEvent("pointerdown", { clientY: 170 }));
      vi.advanceTimersByTime(300);
    });
    // The drag holds the strip open: Alpha's teams are still listed, so
    // Gamma is still under the hand and a small move reorders nothing.
    expect(document.querySelectorAll(".strip__team")).toHaveLength(2);
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientY: 171 })));
    expect(order()).toEqual(["a", "b", "c", "d"]);
    // A real move past Delta (206–256) moves it.
    act(() => window.dispatchEvent(pointerEvent("pointermove", { clientY: 230 })));
    expect(order()).toEqual(["a", "b", "d", "c"]);
    act(() => window.dispatchEvent(pointerEvent("pointerup", { clientY: 230 })));
  });
});
