// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuButton, type MenuButtonProps } from "./MenuButton";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("MenuButton", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const render = (props: Partial<MenuButtonProps> = {}) =>
    act(() =>
      root.render(
        createElement(MenuButton, {
          actions: [],
          ariaLabel: "Create",
          children: "+",
          ...props,
        }),
      ),
    );

  const trigger = () => host.querySelector("button")!;
  // The list is portaled out of the local DOM, so it is found on the document.
  const menu = () => document.querySelector('[role="menu"]');
  const items = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

  const ACTIONS = (calls: string[]) => [
    { id: "agent", label: "Agent", onSelect: () => calls.push("agent") },
    { id: "team", label: "Team", onSelect: () => calls.push("team") },
  ];

  it("keeps its menu closed, and says so", () => {
    render({ actions: ACTIONS([]) });
    expect(menu()).toBeNull();
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a menu of actions, not a listbox of states", () => {
    // The distinction is the reason this exists beside Dropdown: nothing in
    // here is selected, so nothing may report itself as an option.
    render({ actions: ACTIONS([]) });
    act(() => trigger().click());
    expect(menu()).not.toBeNull();
    expect(items().map((i) => i.textContent)).toEqual(["Agent", "Team"]);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("runs the picked action and closes behind it", () => {
    const calls: string[] = [];
    render({ actions: ACTIONS(calls) });
    act(() => trigger().click());
    act(() => items()[1].click());
    expect(calls).toEqual(["team"]);
    expect(menu()).toBeNull();
  });

  it("never claims a menu it has no items for", () => {
    // An empty set would leave `aria-expanded` promising a layer that is not
    // rendered, and a pointer a dead surface to hit.
    render({ actions: [] });
    act(() => trigger().click());
    expect(menu()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("lets go when the pointer presses something else", () => {
    // Shared with Dropdown through `useAwayClose`, and asserted on both sides:
    // the point of one implementation is that neither consumer drifts, which
    // only a test per consumer can show.
    render({ actions: ACTIONS([]) });
    act(() => trigger().click());
    const outside = document.body.appendChild(document.createElement("button"));
    act(() => {
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(menu()).toBeNull();
  });

  it("lets go when the keyboard leaves it", () => {
    render({ actions: ACTIONS([]) });
    act(() => trigger().click());
    const outside = document.body.appendChild(document.createElement("button"));
    act(() => {
      outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(menu()).toBeNull();
  });

  it("closes on Escape from inside, and leaves outside Escape alone", () => {
    const onOuterEscape = vi.fn();
    document.addEventListener("keydown", onOuterEscape);
    try {
      render({ actions: ACTIONS([]) });
      act(() => trigger().click());
      act(() => {
        trigger().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(menu()).toBeNull();
      // Stopped at the menu — a modal layer above keeps its own Escape.
      expect(onOuterEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", onOuterEscape);
    }
  });
});
