// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SuggestedInput } from "./SuggestedInput";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Stateful host — the component is controlled, so tests exercise it the way
 * the dialog does: value round-trips through onChange. */
function Harness({
  init,
  suggestion,
  clearTitle,
}: {
  init: string;
  suggestion: string;
  clearTitle?: string;
}) {
  const [value, setValue] = useState(init);
  return createElement(SuggestedInput, {
    value,
    suggestion,
    onChange: setValue,
    ariaLabel: "Field",
    clearTitle,
    resetTitle: "Reset",
  });
}

const input = () => document.querySelector<HTMLInputElement>("input")!;
const clearBtn = () =>
  document.querySelector<HTMLButtonElement>(
    ".form__field-btn:not(.form__field-btn--reset)",
  );
const resetBtn = () =>
  document.querySelector<HTMLButtonElement>(".form__field-btn--reset");
const hinted = () => input().classList.contains("form__input--hint");

/** Type into a controlled React input: set via the native setter (bypassing
 * React's value tracker) and fire a bubbling `input` event. */
function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    set.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SuggestedInput", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const mount = (props: Parameters<typeof Harness>[0]) =>
    act(() => root.render(createElement(Harness, props)));

  it("shows the untouched suggestion hint-styled, materializes on focus, hints again on blur", () => {
    mount({ init: "kd/agent-1", suggestion: "kd/agent-1" });
    expect(input().value).toBe("kd/agent-1");
    expect(hinted()).toBe(true);

    act(() => input().focus());
    expect(hinted()).toBe(false);

    act(() => input().blur());
    expect(hinted()).toBe(true);
  });

  it("keeps an edited value as ordinary text after blur", () => {
    mount({ init: "kd/agent-1", suggestion: "kd/agent-1" });
    act(() => input().focus());
    type("kd/custom");
    act(() => input().blur());

    expect(input().value).toBe("kd/custom");
    expect(hinted()).toBe(false);
  });

  it("returns to a hint when the user hand-restores the original and blurs", () => {
    mount({ init: "kd/agent-1", suggestion: "kd/agent-1" });
    act(() => input().focus());
    type("kd/custom");
    type("kd/agent-1");
    expect(hinted()).toBe(false); // still focused — stays materialized

    act(() => input().blur());
    expect(hinted()).toBe(true);
  });

  it("clearable: ✕ with text → clearing swaps the slot to ↺ → reset restores the hint", () => {
    mount({
      init: "/wt/agent-1",
      suggestion: "/wt/agent-1",
      clearTitle: "Clear",
    });
    // Text present: the slot is the clear button, never both.
    expect(clearBtn()).not.toBeNull();
    expect(resetBtn()).toBeNull();

    act(() => clearBtn()!.click());
    expect(input().value).toBe("");
    expect(clearBtn()).toBeNull();
    expect(resetBtn()).not.toBeNull(); // undo lives where ✕ just was

    act(() => resetBtn()!.click());
    expect(input().value).toBe("/wt/agent-1");
    expect(hinted()).toBe(true); // restored + unfocused = hint again
    expect(clearBtn()).not.toBeNull();
  });

  it("non-clearable: no buttons while pristine, ↺ once edited, reset hides it", () => {
    mount({ init: "kd/agent-1", suggestion: "kd/agent-1" });
    expect(clearBtn()).toBeNull();
    expect(resetBtn()).toBeNull();

    act(() => input().focus());
    type("other");
    expect(resetBtn()).not.toBeNull();

    act(() => resetBtn()!.click());
    expect(input().value).toBe("kd/agent-1");
    expect(resetBtn()).toBeNull();
  });

  it("moves the default (0,0) caret to the end on focus — Tab/programmatic focus edits at the end", () => {
    mount({ init: "kd/agent-1", suggestion: "kd/agent-1" });
    input().setSelectionRange(0, 0); // the untouched-input default
    act(() => input().focus());

    expect(input().selectionStart).toBe("kd/agent-1".length);
    expect(input().selectionEnd).toBe("kd/agent-1".length);
  });

  it("leaves a deliberately placed caret alone on focus", () => {
    mount({ init: "kd/agent-1", suggestion: "kd/agent-1" });
    input().setSelectionRange(3, 3); // e.g. restored from a prior edit
    act(() => input().focus());

    expect(input().selectionStart).toBe(3);
    expect(input().selectionEnd).toBe(3);
  });

  it("without a suggestion there is never a reset and never a hint", () => {
    mount({ init: "", suggestion: "", clearTitle: "Clear" });
    expect(hinted()).toBe(false);
    expect(clearBtn()).toBeNull();
    expect(resetBtn()).toBeNull();

    act(() => input().focus());
    type("/some/path");
    act(() => input().blur());
    expect(hinted()).toBe(false);
    expect(clearBtn()).not.toBeNull(); // clear still works…

    act(() => clearBtn()!.click());
    expect(resetBtn()).toBeNull(); // …but there's nothing to reset to
  });
});
