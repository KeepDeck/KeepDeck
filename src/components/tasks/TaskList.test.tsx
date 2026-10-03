// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installResizeObserver, pinListViewport } from "@keepdeck/ui-kit/virtualGeometry.test-support";
import { board, task } from "../../domain/tasks/testSupport";
import { NO_QUERY, listView } from "../../presentation/tasks";
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
    act(() => root.render(createElement(TaskList, { items, onSelect: vi.fn(), onFold: vi.fn() })));
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".tasks__row")];
    expect(rows.map((r) => r.querySelector(".tasks__row-title")?.textContent)).toEqual(["Wire", "Draft"]);
    expect(rows[1].querySelector(".tasks__label")?.textContent).toBe("copy");
    expect(rows[0].querySelector(".tasks__row-blocked")?.textContent).toBe("blocked by task-1");
    expect(rows[1].getAttribute("aria-pressed")).toBe("true");
    // The pinned heading names the group of the first row in view.
    expect(host.querySelector(".tasks__list-pinned .tasks__group-label")?.textContent).toBe("Blocked");
  });

  it("emits a row's id on a click and a heading's status on a fold", () => {
    const onSelect = vi.fn();
    const onFold = vi.fn();
    const items = listView(tasks, board(tasks), 0, NO_QUERY, new Set(), null);
    act(() => root.render(createElement(TaskList, { items, onSelect, onFold })));
    act(() => host.querySelector<HTMLButtonElement>(".tasks__row")!.click());
    expect(onSelect).toHaveBeenCalledWith("task-2");
    const heading = [...host.querySelectorAll<HTMLButtonElement>(".tasks__list-item .tasks__group")].find(
      (h) => h.textContent?.startsWith("To do"),
    )!;
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    act(() => heading.click());
    expect(onFold).toHaveBeenCalledWith("todo");
  });
});
