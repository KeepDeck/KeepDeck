// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fuzzyFilterBy } from "./Combobox";
import { SearchPicker } from "./SearchPicker";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("fuzzyFilterBy", () => {
  it("filters items by their text, in fuzzyFilter's tiers", () => {
    const items = [{ id: 1, text: "feat/login" }, { id: 2, text: "login-fix" }, { id: 3, text: "main" }];
    expect(fuzzyFilterBy(items, "log", (item) => item.text).map((item) => item.id)).toEqual([2, 1]);
    expect(fuzzyFilterBy(items, " ", (item) => item.text)).toHaveLength(3);
  });
});

const OPTIONS = [
  { value: "task-2", label: "task-2 · Draft the skill" },
  { value: "task-3", label: "task-3 · Ship the release" },
  { value: "task-4", label: "task-4 · Review the skill" },
];

describe("SearchPicker", () => {
  let host: HTMLElement;
  let root: Root;
  let onPick: ReturnType<typeof vi.fn>;
  let outerEscape: ReturnType<typeof vi.fn>;
  const onWindowKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") outerEscape();
  };

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
    outerEscape = vi.fn();
    // A dialog's own Escape, listening above the picker.
    window.addEventListener("keydown", onWindowKey);
    root = createRoot(host);
    onPick = vi.fn();
    act(() =>
      root.render(
        createElement(SearchPicker, { label: "Add a blocker", placeholder: "Find…", options: OPTIONS, onPick, empty: "nothing matches" }),
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    window.removeEventListener("keydown", onWindowKey);
  });

  const plus = () => host.querySelector<HTMLButtonElement>('button[aria-label="Add a blocker"]');
  const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Add a blocker"]');
  const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((o) => o.textContent);
  const type = (text: string) =>
    act(() => {
      const input = field()!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = (k: string) => act(() => field()!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

  it("is a + until pressed, then a focused search over the whole list", () => {
    expect(field()).toBeNull();
    act(() => plus()!.click());
    expect(plus()).toBeNull();
    expect(document.activeElement).toBe(field());
    expect(options()).toHaveLength(3);
  });

  it("filters as the person types, and picks with Enter what the arrows reached", () => {
    act(() => plus()!.click());
    type("skill");
    expect(options()).toEqual(["task-2 · Draft the skill", "task-4 · Review the skill"]);
    key("ArrowDown");
    key("Enter");
    expect(onPick).toHaveBeenCalledWith("task-4");
    // Picked: back to the +, and the keyboard with it.
    expect(field()).toBeNull();
    expect(document.activeElement).toBe(plus());
  });

  it("picks on a click", () => {
    act(() => plus()!.click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')][1].click());
    expect(onPick).toHaveBeenCalledWith("task-3");
  });

  it("says nothing matches, and Enter then picks nothing", () => {
    act(() => plus()!.click());
    type("zzz");
    expect(document.body.textContent).toContain("nothing matches");
    key("Enter");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("closes on Escape with nothing picked, and keeps the Escape to itself", () => {
    act(() => plus()!.click());
    key("Escape");
    expect(field()).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
    expect(outerEscape).not.toHaveBeenCalled();
  });

  it("closes on a press away", () => {
    act(() => plus()!.click());
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(field()).toBeNull();
  });
});
