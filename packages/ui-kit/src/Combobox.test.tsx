// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Combobox, fuzzyFilter } from "./Combobox";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("fuzzyFilter", () => {
  it("ranks prefix over substring over sparse subsequence", () => {
    // "log" is a prefix of none, substring of "feat/login", subsequence of
    // "large-blob-go"; "login-fix" leads with it.
    const options = ["feat/login", "large-blob-go", "login-fix"];
    expect(fuzzyFilter(options, "log")).toEqual([
      "login-fix",
      "feat/login",
      "large-blob-go",
    ]);
  });

  it("keeps input order within a tier and drops non-matches", () => {
    expect(fuzzyFilter(["ab", "ba", "axb"], "ab")).toEqual(["ab", "axb"]);
  });

  it("matches case-insensitively", () => {
    expect(fuzzyFilter(["Main", "release"], "mAIn")).toEqual(["Main"]);
  });

  it("returns everything for an empty or blank query", () => {
    expect(fuzzyFilter(["a", "b"], "")).toEqual(["a", "b"]);
    expect(fuzzyFilter(["a", "b"], "  ")).toEqual(["a", "b"]);
  });
});

const OPTIONS = ["feat/login", "kd/ws/1", "main", "release-1.2"];

describe("Combobox", () => {
  let host: HTMLElement;
  let root: Root;
  let picked: ReturnType<typeof vi.fn>;

  /** Controlled harness: the combobox needs its value echoed back to filter. */
  function Harness({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return createElement(Combobox, {
      options: OPTIONS,
      value,
      onChange: (v: string) => {
        picked(v);
        setValue(v);
      },
      ariaLabel: "Base branch",
    });
  }

  const mount = (initial = "") =>
    act(() => root.render(createElement(Harness, { initial })));
  const input = () =>
    document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const menu = () => document.querySelector('[role="listbox"]');
  const optionLabels = () =>
    [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);

  /** Type into the controlled input the way a user would. */
  const type = (text: string) =>
    act(() => {
      const el = input();
      const set = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el),
        "value",
      )!.set!;
      set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

  /** Dispatch a key on the input; returns whether default was prevented. */
  const key = (k: string) => {
    const event = new KeyboardEvent("keydown", {
      key: k,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input().dispatchEvent(event);
    });
    return event.defaultPrevented;
  };

  beforeEach(() => {
    picked = vi.fn();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  it("announces the listbox it actually renders", () => {
    mount();
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().getAttribute("aria-controls")).toBeNull();

    act(() => input().focus());
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-controls")).toBe(menu()!.id);

    // Nothing matches -> no listbox is rendered, so the combobox must not
    // claim an expanded one or point at an element that isn't there.
    type("zzz");
    expect(menu()).toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().getAttribute("aria-controls")).toBeNull();
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
  });

  it("focus opens the FULL list even when the value equals an option", () => {
    mount("main");
    expect(menu()).toBeNull();
    act(() => input().focus());
    expect(optionLabels()).toEqual(OPTIONS);
  });

  it("portals the filtered listbox beside the mount and still picks", () => {
    mount();
    act(() => input().focus());
    type("rel");
    expect(optionLabels()).toEqual(["release-1.2"]);
    const listbox = menu()!;
    expect(document.body.contains(listbox)).toBe(true);
    expect(host.contains(listbox)).toBe(false);
    expect(
      [...document.body.children].some(
        (child) => child !== host && child.contains(listbox),
      ),
    ).toBe(true);

    const option = document.querySelector<HTMLButtonElement>('[role="option"]')!;
    // A portaled option remains part of the combobox interaction even though
    // it is outside the input wrapper in the DOM.
    act(() => {
      option.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(menu()).toBe(listbox);
    act(() => option.click());
    expect(picked).toHaveBeenLastCalledWith("release-1.2");
    expect(menu()).toBeNull();
  });

  it("shows no menu when nothing matches", () => {
    mount();
    act(() => input().focus());
    type("zzz");
    expect(menu()).toBeNull();
  });

  it("Enter with the menu open picks the highlight and stops the form default", () => {
    mount();
    act(() => input().focus());
    const prevented = key("Enter");
    expect(prevented).toBe(true);
    expect(picked).toHaveBeenLastCalledWith("feat/login");
    expect(menu()).toBeNull();
  });

  it("Enter with the menu closed keeps its form meaning", () => {
    mount();
    // Never focused — the menu was never opened.
    expect(key("Enter")).toBe(false);
    expect(picked).not.toHaveBeenCalled();
  });

  it("arrows move the highlight and Enter picks the moved-to option", () => {
    mount();
    act(() => input().focus());
    key("ArrowDown");
    key("ArrowDown");
    key("Enter");
    expect(picked).toHaveBeenLastCalledWith(OPTIONS[2]);
  });

  it("ArrowDown reopens a closed menu instead of moving", () => {
    mount();
    act(() => input().focus());
    key("Escape"); // close, keep focus
    expect(menu()).toBeNull();
    key("ArrowDown");
    expect(optionLabels()).toEqual(OPTIONS);
    key("Enter");
    expect(picked).toHaveBeenLastCalledWith(OPTIONS[0]);
  });

  it("Escape closes locally while open, then bubbles once closed", () => {
    mount();
    act(() => input().focus());
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    key("Escape");
    expect(menu()).toBeNull();
    expect(seen).not.toHaveBeenCalled(); // consumed by the open combobox
    key("Escape");
    expect(seen).toHaveBeenCalledTimes(1); // a closed one lets modals have it
    window.removeEventListener("keydown", seen);
  });

  it("a click outside closes without picking", () => {
    mount();
    act(() => input().focus());
    expect(menu()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(picked).not.toHaveBeenCalled();
  });

  it("closes when keyboard focus moves outside the portaled interaction", () => {
    const outside = document.body.appendChild(document.createElement("button"));
    mount();
    act(() => input().focus());
    expect(menu()).not.toBeNull();

    act(() => outside.focus());
    expect(menu()).toBeNull();
    expect(picked).not.toHaveBeenCalled();
  });
});
