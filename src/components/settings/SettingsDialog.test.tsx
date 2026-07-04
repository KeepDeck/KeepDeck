// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FALLBACK_AGENTS } from "../../domain/agents";
import {
  DEFAULT_SETTINGS,
  SCROLLBACK_MIN,
  type Settings,
} from "../../domain/settings";
import { SettingsDialog } from "./SettingsDialog";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  )!;
const scrollbackInput = () =>
  document.querySelector<HTMLInputElement>(
    'input[aria-label="Terminal scrollback lines"]',
  )!;
const checkbox = () =>
  document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

/** Type into a controlled React input: set via the native setter (bypassing
 * React's value tracker) and fire a bubbling `input` event. */
function type(el: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const blur = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

describe("SettingsDialog", () => {
  let root: Root;
  let changes: Partial<Settings>[];
  let closed: number;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    changes = [];
    closed = 0;
  });

  afterEach(() => act(() => root.unmount()));

  const mount = (overrides: Partial<Settings> = {}) =>
    act(() =>
      root.render(
        createElement(SettingsDialog, {
          settings: { ...DEFAULT_SETTINGS, ...overrides },
          agents: FALLBACK_AGENTS,
          onChange: (patch: Partial<Settings>) => changes.push(patch),
          onClose: () => closed++,
        }),
      ),
    );

  it("picking an agent (or Auto) writes the default through", () => {
    mount({ defaultAgent: "codex" });
    act(() => button("Claude Code").click());
    act(() => button("Auto").click());
    expect(changes).toEqual([{ defaultAgent: "claude" }, { defaultAgent: null }]);
  });

  it("marks the active choice", () => {
    mount({ defaultAgent: "codex" });
    expect(button("Codex").className).toContain("form__type--active");
    expect(button("Auto").className).not.toContain("form__type--active");
  });

  it("scrollback commits clamped on blur — not per keystroke", () => {
    mount();
    type(scrollbackInput(), "7");
    expect(changes).toEqual([]); // still typing
    blur(scrollbackInput());
    expect(changes).toEqual([{ scrollback: SCROLLBACK_MIN }]);
    expect(scrollbackInput().value).toBe(String(SCROLLBACK_MIN));
  });

  it("a non-number reverts to the live value instead of writing", () => {
    mount();
    type(scrollbackInput(), "lots");
    blur(scrollbackInput());
    expect(changes).toEqual([]);
    expect(scrollbackInput().value).toBe(String(DEFAULT_SETTINGS.scrollback));
  });

  it("an unchanged commit writes nothing", () => {
    mount();
    blur(scrollbackInput());
    expect(changes).toEqual([]);
  });

  it("the close-confirm toggle writes through", () => {
    mount();
    act(() => checkbox().click());
    expect(changes).toEqual([{ confirmBeforeClose: false }]);
  });

  it("Done and Escape only dismiss", () => {
    mount();
    act(() => button("Done").click());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(closed).toBe(2);
    expect(changes).toEqual([]);
  });
});
