// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dropdown } from "./Dropdown";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { value: "/wt/a", label: "kd/a" },
  { value: "/repo", label: "Workspace folder" },
];

describe("Dropdown", () => {
  let host: HTMLElement;
  let root: Root;
  let onChange: ReturnType<typeof vi.fn>;

  const mount = (value = "/wt/a") =>
    act(() =>
      root.render(
        createElement(Dropdown, {
          options: OPTIONS,
          value,
          onChange,
          ariaLabel: "Pick",
        }),
      ),
    );
  const button = () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Pick"]')!;
  const menu = () => document.querySelector('[role="listbox"]');

  beforeEach(() => {
    onChange = vi.fn();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  it("shows the current option's label and no native select anywhere", () => {
    mount();
    expect(button().textContent).toBe("kd/a");
    expect(document.querySelector("select")).toBeNull();
  });

  it("portals its listbox beside the mount and still picks an option", () => {
    mount();
    expect(menu()).toBeNull();
    act(() => button().click());
    const listbox = menu()!;
    expect(document.body.contains(listbox)).toBe(true);
    expect(host.contains(listbox)).toBe(false);
    expect(
      [...document.body.children].some(
        (child) => child !== host && child.contains(listbox),
      ),
    ).toBe(true);

    const options = document.querySelectorAll<HTMLButtonElement>(
      '[role="option"]',
    );
    expect([...options].map((o) => o.textContent)).toEqual([
      "kd/a",
      "Workspace folder",
    ]);

    // The option lives outside the control's subtree, but is still inside the
    // dropdown interaction: its pointerdown must not be mistaken for click-away.
    act(() => {
      options[1].dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(menu()).toBe(listbox);
    act(() => options[1].click());
    expect(onChange).toHaveBeenCalledWith("/repo");
    expect(menu()).toBeNull();
  });

  it("a click outside closes without picking", () => {
    mount();
    act(() => button().click());
    act(() => {
      document.body.dispatchEvent(
        new Event("pointerdown", { bubbles: true }),
      );
    });
    expect(menu()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes when keyboard focus moves outside the portaled interaction", () => {
    const outside = document.body.appendChild(document.createElement("button"));
    mount();
    act(() => button().click());

    act(() => outside.focus());
    expect(menu()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Escape closes and stays local (no bubbling to modal layers)", () => {
    mount();
    act(() => button().click());
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    act(() => {
      button().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    window.removeEventListener("keydown", seen);
    expect(menu()).toBeNull();
    expect(seen).not.toHaveBeenCalled();
  });
});
