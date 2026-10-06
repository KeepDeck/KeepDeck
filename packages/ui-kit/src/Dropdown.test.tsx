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

  const mount = (value = "/wt/a", options = OPTIONS) =>
    act(() =>
      root.render(
        createElement(Dropdown, {
          options,
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

  it("inline: a value in a line, its menu as wide as its options — not as the narrow value", () => {
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const width = this.matches('[role="listbox"]') ? 180 : this.classList.contains("dropdown") ? 48 : 0;
      return { x: 0, y: 0, top: 0, left: 0, bottom: 20, right: width, width, height: 20, toJSON: () => ({}) } as DOMRect;
    });
    try {
      act(() =>
        root.render(createElement(Dropdown, { options: OPTIONS, value: "/wt/a", onChange, ariaLabel: "Pick", variant: "inline" })),
      );
      expect(host.querySelector(".dropdown")!.className).toBe("dropdown dropdown--inline");
      act(() => button().click());
      expect((menu() as HTMLElement).style.width).toBe("180px");
      // The field keeps its column's width for its menu.
      act(() => button().click());
      mount();
      act(() => button().click());
      expect((menu() as HTMLElement).style.width).toBe("48px");
    } finally {
      rect.mockRestore();
    }
  });

  it("takes a small size and a quiet offer by name, never by a call-site restyle", () => {
    act(() =>
      root.render(createElement(Dropdown, { options: OPTIONS, value: "/wt/a", onChange, ariaLabel: "Pick", size: "sm", quiet: true })),
    );
    expect(host.querySelector(".dropdown")!.className).toBe("dropdown dropdown--sm dropdown--quiet");
    mount();
    expect(host.querySelector(".dropdown")!.className).toBe("dropdown");
  });

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

  it("keeps focus on the trigger after a pick", () => {
    mount();
    act(() => button().click());
    const option = document.querySelectorAll<HTMLButtonElement>(
      '[role="option"]',
    )[1];

    act(() => option.click());

    // The picked option unmounts with the menu; focus must land back on the
    // control, not on <body>.
    expect(document.activeElement).toBe(button());
  });

  it("shows a disabled option that cannot be picked, and its note under the options", () => {
    act(() =>
      root.render(
        createElement(Dropdown, {
          options: [OPTIONS[0], { ...OPTIONS[1], disabled: true }],
          value: "/wt/a",
          onChange,
          ariaLabel: "Pick",
          note: "Not now — it is closed",
        }),
      ),
    );
    act(() => button().click());
    const refused = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')][1];
    expect(refused.disabled).toBe(true);
    expect(refused.getAttribute("aria-disabled")).toBe("true");
    act(() => refused.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(menu()?.querySelector(".dropdown__note")?.textContent).toBe("Not now — it is closed");
    // No note, no small print.
    act(() => button().click());
    mount();
    act(() => button().click());
    expect(menu()?.querySelector(".dropdown__note")).toBeNull();
  });

  it("opens no listbox when there is nothing to pick", () => {
    mount("/wt/a", []);
    act(() => button().click());

    expect(menu()).toBeNull();
    // An empty option set means there is no listbox to announce or point at.
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(button().getAttribute("aria-controls")).toBeNull();
  });

  it("announces the listbox it actually renders", () => {
    mount();
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(button().getAttribute("aria-controls")).toBeNull();

    act(() => button().click());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(button().getAttribute("aria-controls")).toBe(menu()!.id);
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

  it("keeps focus on the trigger after Escape from an option", () => {
    // The half of the going-away discipline that was missing here while a
    // pick already had it: Escape unmounts the focused option just the same,
    // and focus falls to <body> unless it is put back.
    mount();
    act(() => button().click());
    const option = document.querySelectorAll<HTMLButtonElement>(
      '[role="option"]',
    )[1];
    act(() => option.focus());
    act(() => {
      option.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button());
  });
});
