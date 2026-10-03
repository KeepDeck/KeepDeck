// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installResizeObserver, pinListViewport } from "@keepdeck/ui-kit/virtualGeometry.test-support";
import { board, task } from "../../domain/tasks/testSupport";
import { IDLE, NO_QUERY, listView } from "../../presentation/tasks";
import { TaskList } from "./TaskList";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let restore: () => void;
beforeEach(() => {
  installResizeObserver();
  restore = pinListViewport("tasks__list", 400, 600, 34);
  document.body.innerHTML = "";
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  restore();
});

const tasks = [
  task({ id: "task-1", title: "Draft", labels: ["copy"] }),
  task({ id: "task-2", title: "Wire", status: "blocked", blockedBy: ["task-1"] }),
];

describe("TaskList", () => {
  it("draws a heading per status and a line per task, with its labels and what holds it", () => {
    const items = listView(tasks, board(tasks), 0, NO_QUERY, new Set(), "task-1");
    act(() => root.render(createElement(TaskList, { items, openId: null, drag: IDLE, hover: null, onArm: vi.fn(), onHover: vi.fn(), onDrop: vi.fn(), onSelect: vi.fn(), onFold: vi.fn(), onLabel: vi.fn() })));
    const rows = [...host.querySelectorAll<HTMLElement>(".tasks__row")];
    expect(rows.map((r) => r.querySelector(".tasks__row-title")?.textContent)).toEqual(["Wire", "Draft"]);
    expect(rows[1].querySelector(".kd-tag")?.textContent).toBe("copy");
    expect(rows[0].querySelector(".tasks__tag--blocking")?.textContent).toBe("task-1");
    expect(rows[0].querySelector(".tasks__row-who")?.textContent).toBe("pool");
    expect(rows[1].querySelector(".tasks__row-open")?.getAttribute("aria-pressed")).toBe("true");
    // The pinned heading names the group of the first row in view.
    expect(host.querySelector(".tasks__list-pinned .tasks__group-label")?.textContent).toBe("Blocked");
  });

  it("emits a row's id on a click, a label to filter by, a blocker to open, and a heading's status on a fold", () => {
    const onSelect = vi.fn();
    const onFold = vi.fn();
    const onLabel = vi.fn();
    const items = listView(tasks, board(tasks), 0, NO_QUERY, new Set(), null);
    act(() => root.render(createElement(TaskList, { items, openId: null, drag: IDLE, hover: null, onArm: vi.fn(), onHover: vi.fn(), onDrop: vi.fn(), onSelect, onFold, onLabel })));
    act(() => host.querySelector<HTMLButtonElement>(".tasks__row-open")!.click());
    expect(onSelect).toHaveBeenCalledWith("task-2");
    // A label narrows the view; a blocker opens the task that holds it.
    act(() => host.querySelector<HTMLButtonElement>(".tasks__row .kd-tag:not(.kd-tag--outline)")!.click());
    expect(onLabel).toHaveBeenCalledWith("copy");
    act(() => host.querySelector<HTMLButtonElement>(".tasks__row .tasks__tag--blocking")!.click());
    expect(onSelect).toHaveBeenLastCalledWith("task-1");
    const heading = [...host.querySelectorAll<HTMLButtonElement>(".tasks__list-item .tasks__group")].find(
      (h) => h.textContent?.startsWith("To do"),
    )!;
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    act(() => heading.click());
    expect(onFold).toHaveBeenCalledWith("todo");
  });

  it("takes a drop on the pinned heading as its group does, and keeps it the pointer's alone", () => {
    const onDrop = vi.fn();
    const onHover = vi.fn();
    const items = listView(tasks, board(tasks), 0, NO_QUERY, new Set(), null);
    act(() => root.render(createElement(TaskList, { items, openId: null, drag: IDLE, hover: null, onArm: vi.fn(), onHover, onDrop, onSelect: vi.fn(), onFold: vi.fn(), onLabel: vi.fn() })));
    // At the top it lies right over the first heading, so a release there
    // reaches it, not the heading under it.
    const pinned = host.querySelector<HTMLButtonElement>(".tasks__list-pinned .tasks__group")!;
    act(() => {
      pinned.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      pinned.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    expect(onHover).toHaveBeenCalledWith("blocked");
    expect(onDrop).toHaveBeenCalledWith("blocked");
    // The real heading is the one the keyboard and a reader reach.
    expect(pinned.getAttribute("aria-hidden")).toBe("true");
    expect(pinned.tabIndex).toBe(-1);
    expect(pinned.hasAttribute("aria-expanded")).toBe(false);
  });
});
