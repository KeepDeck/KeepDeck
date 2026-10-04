// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installResizeObserver, pinListViewport } from "@keepdeck/ui-kit/virtualGeometry.test-support";
import { CommandPalette, type PaletteSection } from "./CommandPalette";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SECTIONS: PaletteSection[] = [
  {
    title: "Tasks",
    items: [
      { value: "task-2", label: "task-2  Draft the skill", hint: "To do" },
      { value: "task-3", label: "task-3  Ship the release", hint: "In progress" },
    ],
  },
  { title: "More", items: [{ value: "task-4", label: "task-4  Review the skill", hint: "Backlog" }] },
];

describe("CommandPalette", () => {
  let root: Root;
  let onPick: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;
  let restore: () => void = () => {};

  beforeEach(() => {
    installResizeObserver();
    // The list is windowed: the browser's geometry, pinned.
    restore = pinListViewport("palette__list", 400, 640, 34);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    onPick = vi.fn();
    onClose = vi.fn();
    act(() =>
      root.render(
        createElement(CommandPalette, { label: "Blocked by", placeholder: "Find a task…", sections: SECTIONS, empty: "No task matches", onPick, onClose }),
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    restore();
  });

  it("mounts only the rows in view of a long list, and keeps the highlighted one in view", () => {
    const many: PaletteSection[] = [
      { title: "Tasks", items: Array.from({ length: 500 }, (_, i) => ({ value: `task-${i}`, label: `task-${i}  Work` })) },
    ];
    act(() => root.render(createElement(CommandPalette, { label: "Blocked by", placeholder: "Find…", sections: many, empty: "none", onPick, onClose })));
    expect(document.querySelectorAll(".palette__item").length).toBeLessThan(40);
    key("ArrowUp");
    const list = document.querySelector<HTMLElement>(".palette__list")!;
    expect(list.scrollTop).toBeGreaterThan(0);
    // The browser tells the list it scrolled; the row is mounted then.
    act(() => list.dispatchEvent(new Event("scroll")));
    // Wrapped to the last row: revealed, so mounted.
    expect(document.querySelector(".palette__item--active .palette__label")?.textContent).toBe("task-499  Work");
  });

  const field = () => document.querySelector<HTMLInputElement>(".palette__field")!;
  const rows = () => [...document.querySelectorAll<HTMLElement>(".palette__item")].map((row) => row.querySelector(".palette__label")!.textContent);
  const sections = () => [...document.querySelectorAll(".palette__section")].map((s) => s.textContent);
  const type = (text: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), text);
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = (k: string) => act(() => field().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

  it("opens with its search field focused, every section under it", () => {
    expect(document.activeElement).toBe(field());
    expect(field().placeholder).toBe("Find a task…");
    expect(sections()).toEqual(["Tasks", "More"]);
    expect(rows()).toHaveLength(3);
  });

  it("filters every section as the person types — by a row's words and its hint — and drops the empty ones", () => {
    type("skill");
    expect(rows()).toEqual(["task-2  Draft the skill", "task-4  Review the skill"]);
    type("progress");
    expect(rows()).toEqual(["task-3  Ship the release"]);
    expect(sections()).toEqual(["Tasks"]);
  });

  it("walks every section as one list, and Enter picks and is done", () => {
    key("ArrowDown");
    key("ArrowDown");
    key("Enter");
    expect(onPick).toHaveBeenCalledWith("task-4");
    expect(onClose).toHaveBeenCalled();
  });

  it("says nothing matches, and then Enter picks nothing", () => {
    type("zzz");
    expect(document.querySelector(".palette__empty")?.textContent).toBe("No task matches");
    key("Enter");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("closes on Escape, and on a press on the backdrop — not on one inside the panel", () => {
    act(() => document.querySelector(".palette")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => document.querySelector(".palette__backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("picks on a click", () => {
    act(() => [...document.querySelectorAll<HTMLButtonElement>(".palette__item")][1].click());
    expect(onPick).toHaveBeenCalledWith("task-3");
  });
});
