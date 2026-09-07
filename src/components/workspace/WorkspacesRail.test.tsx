// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacesRail, type WorkspaceItem } from "./WorkspacesRail";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const START: WorkspaceItem[] = [
  { id: "a", name: "Alpha", teamCount: 1, teams: [], expanded: false },
  { id: "b", name: "Beta", teamCount: 2, teams: [], expanded: false, dot: "waiting" },
  { id: "c", name: "Gamma", teamCount: 3, teams: [], expanded: false },
  { id: "d", name: "Delta", teamCount: 4, teams: [], expanded: false },
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
    onEnterTeam: () => {},
    onToggleTeams: () => {},
    onRenameTeam: () => {},
    onReorder: (id: string, toIndex: number) =>
      setItems((current) => move(current, id, toIndex)),
    version: null,
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
    // The ghost is the item's image: it wears the item's status frame.
    expect(document.querySelector(".rail__ghost .rail__dot")!.className).toBe(
      "rail__dot rail__dot--waiting",
    );

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

function restorePrototypeProperty(
  name: "offsetTop" | "offsetLeft" | "offsetWidth" | "offsetHeight",
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
}

describe("WorkspacesRail workspace metadata", () => {
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

  it("shows only the numeric team count, without a model-icon cluster", () => {
    const item = host.querySelector(`[data-ws-id="b"]`)!;
    expect(item.querySelector(".rail__count")?.textContent).toBe("2");
    expect(item.querySelector(".rail__agents")).toBeNull();
  });

  it("paints the dot from the folded status frame, verbatim", () => {
    act(() =>
      root.render(
        createElement(WorkspacesRail, {
          workspaces: [
            { id: "a", name: "Alpha", teamCount: 1, teams: [], expanded: false, dot: "selected" },
            { id: "b", name: "Beta", teamCount: 2, teams: [], expanded: false, dot: "failed" },
            { id: "c", name: "Gamma", teamCount: 1, teams: [], expanded: false, dot: "none" },
            { id: "d", name: "Delta", teamCount: 1, teams: [], expanded: false },
          ],
          activeId: "a",
          onSelect: () => {},
          onAdd: () => {},
          onClose: () => {},
          onRename: () => {},
          onEnterTeam: () => {},
          onToggleTeams: () => {},
          onRenameTeam: () => {},
          onReorder: () => {},
          version: null,
        }),
      ),
    );
    const dot = (id: string) =>
      host.querySelector(`[data-ws-id="${id}"] .rail__dot`)!.className;
    expect(dot("a")).toBe("rail__dot rail__dot--selected");
    expect(dot("b")).toBe("rail__dot rail__dot--failed");
    // "none" and an absent frame both mean the bare gray dot.
    expect(dot("c")).toBe("rail__dot");
    expect(dot("d")).toBe("rail__dot");
  });

  it("signs the rail with the build, and stays silent without one", () => {
    // The build number left the top bar for the rail's foot, and every other
    // test here passes `version: null` — so the branch that actually draws it
    // was the one branch nothing looked at.
    const renderRail = (version: string | null) =>
      act(() =>
        root.render(
          createElement(WorkspacesRail, {
            workspaces: [{ id: "a", name: "Alpha", teamCount: 1, teams: [], expanded: false }],
            activeId: "a",
            onSelect: () => {},
            onAdd: () => {},
            onClose: () => {},
            onRename: () => {},
            onEnterTeam: () => {},
            onToggleTeams: () => {},
            onRenameTeam: () => {},
            onReorder: () => {},
            version,
          }),
        ),
      );

    renderRail(null);
    expect(host.querySelector(".rail__foot")).toBeNull();

    renderRail("0.22.0");
    const foot = host.querySelector(".rail__foot")!;
    // The number is what shows; the app's name comes with it on hover, so the
    // foot reads as a signature rather than as a stray figure.
    expect(foot.textContent).toBe("0.22.0");
    expect(foot.getAttribute("title")).toBe("KeepDeck 0.22.0");
  });
});

describe("WorkspacesRail team rows", () => {
  let host: HTMLDivElement;
  let root: Root;

  const WITH_TEAMS: WorkspaceItem[] = [
    {
      id: "a",
      name: "Alpha",
      teamCount: 2,
      teams: [
        { id: "team-1", name: "api", size: 3 },
        { id: "team-2", name: "web", size: 0 },
      ],
      expanded: true,
    },
    { id: "b", name: "Beta", teamCount: 0, teams: [], expanded: false },
  ];

  const render = (props: Partial<Parameters<typeof WorkspacesRail>[0]> = {}) =>
    act(() =>
      root.render(
        createElement(WorkspacesRail, {
          workspaces: WITH_TEAMS,
          activeId: "a",
          onSelect: () => {},
          onAdd: () => {},
          onClose: () => {},
          onRename: () => {},
          onEnterTeam: () => {},
          onToggleTeams: () => {},
          onRenameTeam: () => {},
          onReorder: () => {},
          version: null,
          ...props,
        }),
      ),
    );

  const teamRow = (name: string) =>
    [...host.querySelectorAll<HTMLElement>(".rail__team")].find(
      (row) => row.querySelector(".rail__team-name")?.textContent === name,
    )!;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("lists a workspace's teams under its own row, inside its item", () => {
    render();
    // Inside the item on purpose: the hit-test measures item rectangles, so
    // rows living beside them would open a gap the drag reads as the next
    // workspace. And never tagged with the workspace id, or they would BE
    // drag targets.
    const item = host.querySelector('[data-ws-id="a"]')!;
    expect([...item.querySelectorAll(".rail__team-name")].map((n) => n.textContent))
      .toEqual(["api", "web"]);
    expect(item.querySelectorAll(".rail__teams [data-ws-id]")).toHaveLength(0);
    expect(host.querySelector('[data-ws-id="b"] .rail__team')).toBeNull();
  });

  it("says how many agents are on each team, zero included", () => {
    render();
    const size = (name: string) =>
      teamRow(name).querySelector(".rail__team-size")?.textContent;
    expect(size("api")).toBe("3");
    // A team born empty is still a team, and its row says so rather than
    // going blank the way the workspace count does at zero.
    expect(size("web")).toBe("0");
  });

  it("goes into the team the row names, workspace and all", () => {
    const entered: [string, string][] = [];
    render({ onEnterTeam: (wsId, teamId) => entered.push([wsId, teamId]) });
    act(() => {
      teamRow("web").dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(entered).toEqual([["a", "team-2"]]);
  });

  it("renames the team a double click opens, not the workspace above it", () => {
    const renamedTeams: [string, string, string][] = [];
    const renamedWorkspaces: [string, string][] = [];
    render({
      onRenameTeam: (wsId, teamId, name) => renamedTeams.push([wsId, teamId, name]),
      onRename: (id, name) => renamedWorkspaces.push([id, name]),
    });
    act(() => {
      teamRow("api").dispatchEvent(new Event("dblclick", { bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>(".rail__team-rename")!;
    expect(input.value).toBe("api");
    act(() => {
      // Through the native setter: React tracks the value it wrote, and a
      // plain assignment would leave the controlled input's state behind.
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "core");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(
        Object.assign(new Event("keydown", { bubbles: true }), { key: "Enter" }),
      );
    });
    expect(renamedTeams).toEqual([["a", "team-1", "core"]]);
    // One rename at a time, and it belonged to the team: the workspace's own
    // name is untouched because both share a single subject key.
    expect(renamedWorkspaces).toEqual([]);
  });

  it("does not drag the workspace out from under a held team row", () => {
    const reordered: string[] = [];
    render({ onReorder: (id) => reordered.push(id) });
    const row = teamRow("api");
    act(() => {
      row.dispatchEvent(pointerEvent("pointerdown", { clientY: 40 }));
      vi.advanceTimersByTime(400);
    });
    act(() => {
      document.dispatchEvent(pointerEvent("pointermove", { clientY: 200 }));
    });
    // The rows sit inside the workspace's item, so the press reaches the
    // item's own pointerdown; without the row's exemption a 300ms hold on a
    // team would lift the workspace instead of opening the team.
    expect(document.querySelector(".rail__ghost")).toBeNull();
    expect(reordered).toEqual([]);
  });
});
