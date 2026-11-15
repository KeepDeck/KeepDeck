// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuProps } from "./ContextMenu";
import { present } from "@keepdeck/plugin-api/testing";

describe("ContextMenu", () => {
  let root: Root;
  let host: HTMLElement;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    opener = document.body.appendChild(document.createElement("button"));
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const calls: string[] = [];
  const ACTIONS = [
    { id: "archive", label: "Archive…", onSelect: () => calls.push("archive") },
    { id: "rename", label: "Rename", onSelect: () => calls.push("rename"), separatorBefore: true },
    { id: "close", label: "Close", onSelect: () => calls.push("close"), disabled: true, refusal: "Busy" },
  ];

  const render = (props: Partial<ContextMenuProps> = {}) => {
    const onClose = vi.fn();
    act(() =>
      root.render(
        createElement(ContextMenu, { at: { x: 40, y: 120 }, actions: ACTIONS, ariaLabel: "Workspace web", onClose, ...props }),
      ),
    );
    return onClose;
  };
  const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  const key = (target: Element, name: string) =>
    act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));

  it("opens the menu at the pointer, focus on its first item", () => {
    opener.focus();
    render();
    const anchor = present(document.querySelector<HTMLElement>(".kd-context-menu__anchor"), "the anchor");
    expect([anchor.style.left, anchor.style.top]).toEqual(["40px", "120px"]);
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Workspace web");
    expect(items().map((item) => item.textContent)).toEqual(["Archive…", "Rename", "CloseBusy"]);
    expect(document.activeElement).toBe(items()[0]);
  });

  it("draws a rule where a group of acts begins", () => {
    render();
    const rows = Array.from(document.querySelectorAll('[role="menu"] > li')).map((li) => li.getAttribute("role"));
    expect(rows).toEqual(["none", "separator", "none", "none"]);
  });

  it("is walked by the keyboard like every menu here", () => {
    render();
    key(items()[0], "ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    key(items()[1], "End");
    expect(document.activeElement).toBe(items()[2]);
    key(items()[2], "ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("runs a pick, lets go, and hands focus back to what had it", () => {
    calls.length = 0;
    opener.focus();
    const onClose = render();
    act(() => items()[1].click());
    expect(calls).toEqual(["rename"]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("lets go on Escape, once, and a refused item does nothing", () => {
    calls.length = 0;
    const onClose = render();
    act(() => items()[2].click());
    expect(calls).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    key(items()[0], "Escape");
    // Putting focus back is a focus elsewhere too; it must not close twice.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets go on a press elsewhere", () => {
    const onClose = render();
    act(() => void opener.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
