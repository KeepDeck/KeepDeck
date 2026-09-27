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
  teams: {
    wsId: "a",
    wsName: "Alpha",
    rows: [
      { id: "t1", name: "api", size: 3, open: true, pending: false, dot: null, actions: ["add-member", "rename", "disband"] },
      {
        id: "t2",
        name: "docs",
        size: 0,
        open: false,
        pending: true,
        dot: "failed",
        actions: ["add-member", "rename", "disband", "retry"],
      },
    ],
  },
};

const callbacks = {
  onToggleTeams: vi.fn(),
  onSelect: vi.fn(),
  onAdd: vi.fn(),
  onClose: vi.fn(),
  onRename: vi.fn(),
  onReorder: vi.fn(),
  onEnterTeam: vi.fn(),
  onRenameTeam: vi.fn(),
  onTeamAction: vi.fn(),
  onAddTeam: vi.fn(),
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
          teamsShown: true,
          version: null,
          ...callbacks,
          ...props,
        }),
      ),
    );
  const byLabel = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const menuItems = () =>
    [...document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
  const typeInto = (input: HTMLInputElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const pressEnter = (input: HTMLInputElement) =>
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

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

  it("lists the open workspace's teams, the one on the stage marked, and enters one on click", () => {
    render();
    const rows = [...host.querySelectorAll<HTMLElement>(".strip__team")];
    expect(rows.map((r) => r.querySelector(".strip__team-name")?.textContent)).toEqual(["api", "docs"]);
    expect(rows[0].classList.contains("strip__team--open")).toBe(true);
    expect(rows[1].classList.contains("strip__team--pending")).toBe(true);
    expect(rows[1].querySelector(".strip__dot--failed")).not.toBeNull();
    expect(rows[0].querySelector(".strip__dot")).toBeNull();
    expect(rows[0].querySelector(".strip__team-size")?.textContent).toBe("3");
    act(() => rows[1].querySelector<HTMLButtonElement>(".strip__team-open")!.click());
    expect(callbacks.onEnterTeam).toHaveBeenCalledWith("a", "t2");
  });

  it("offers each team's actions in its menu, performing all but rename through the owner", () => {
    render();
    act(() => byLabel("Team docs actions")!.click());
    expect(menuItems().map((i) => i.textContent)).toEqual([
      "Add member",
      "Rename",
      "Disband",
      "Retry the worktree",
    ]);
    act(() => menuItems()[3].click());
    expect(callbacks.onTeamAction).toHaveBeenCalledWith("a", "t2", "retry");
    act(() => byLabel("Team api actions")!.click());
    act(() => menuItems()[2].click());
    expect(callbacks.onTeamAction).toHaveBeenLastCalledWith("a", "t1", "disband");
    expect(callbacks.onEnterTeam).not.toHaveBeenCalled();
  });

  it("renames a team inline from its menu, and on double-click", () => {
    render();
    act(() => byLabel("Team api actions")!.click());
    act(() => menuItems()[1].click());
    const input = host.querySelector<HTMLInputElement>("input[aria-label='Rename team']")!;
    expect(input.value).toBe("api");
    typeInto(input, " platform ");
    pressEnter(input);
    expect(callbacks.onRenameTeam).toHaveBeenCalledWith("a", "t1", "platform");
    act(() => {
      host
        .querySelectorAll<HTMLButtonElement>(".strip__team-open")[1]
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(host.querySelector<HTMLInputElement>("input[aria-label='Rename team']")?.value).toBe("docs");
  });

  it("renames and closes the workspace from the list's head", () => {
    render();
    act(() => byLabel("Workspace Alpha actions")!.click());
    expect(menuItems().map((i) => i.textContent)).toEqual(["Rename", "Close workspace"]);
    act(() => menuItems()[0].click());
    const input = host.querySelector<HTMLInputElement>("input[aria-label='Workspace name']")!;
    typeInto(input, "Omega");
    pressEnter(input);
    expect(callbacks.onRename).toHaveBeenCalledWith("a", "Omega");
    act(() => byLabel("Workspace Alpha actions")!.click());
    act(() => menuItems()[1].click());
    expect(callbacks.onClose).toHaveBeenCalledWith("a");
  });

  it("starts a team from the head only when one can be, and hides the list from there", () => {
    render();
    act(() => byLabel("New team")!.click());
    expect(callbacks.onAddTeam).toHaveBeenCalledOnce();
    act(() => byLabel("Hide teams")!.click());
    expect(callbacks.onToggleTeams).toHaveBeenCalledOnce();
    render({ onAddTeam: null });
    expect(byLabel("New team")).toBeNull();
  });

  it("keeps the marks and drops the list while the list is hidden", () => {
    render({ teamsShown: false });
    expect(host.querySelectorAll("[data-ws-id]")).toHaveLength(4);
    expect(host.querySelector(".strip__teams")).toBeNull();
    expect(host.querySelector(".strip")?.classList.contains("strip--marks-only")).toBe(true);
  });

  it("says a workspace has no teams in words", () => {
    render({ view: { ...VIEW, teams: { wsId: "a", wsName: "Alpha", rows: [] } } });
    expect(host.querySelector(".strip__empty")?.textContent).toBe("No teams yet");
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
    teamsShown: true,
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
