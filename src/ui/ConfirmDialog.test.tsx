// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const baseProps = {
  title: "Close agent?",
  message: "Its terminal session will be ended.",
  confirmLabel: "Close",
  cancelLabel: "Cancel",
  destructive: true,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

const buttons = () =>
  [...document.querySelectorAll<HTMLButtonElement>(".confirm__actions button")];

describe("ConfirmDialog — secondary action", () => {
  let root: Root;

  beforeEach(() => {
    baseProps.onConfirm.mockClear();
    baseProps.onCancel.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const render = (overrides: Record<string, unknown> = {}) =>
    act(() =>
      root.render(createElement(ConfirmDialog, { ...baseProps, ...overrides })),
    );

  it("is absent unless asked for, leaving the two-button dialog untouched", () => {
    render();
    expect(buttons().map((b) => b.textContent)).toEqual(["Cancel", "Close"]);
  });

  it("sits between cancel and the destructive confirm, and fires its action", () => {
    const onClick = vi.fn();
    render({ secondaryAction: { label: "Suspend", onClick } });

    // Order matters: the destructive confirm keeps its position on the end.
    expect(buttons().map((b) => b.textContent)).toEqual([
      "Cancel",
      "Suspend",
      "Close",
    ]);
    act(() => buttons()[1].click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(baseProps.onConfirm).not.toHaveBeenCalled();
    expect(baseProps.onCancel).not.toHaveBeenCalled();
  });

  it("keeps Cancel focused — the softer option must not steal the safe default", () => {
    render({ secondaryAction: { label: "Suspend", onClick: vi.fn() } });
    expect(document.activeElement).toBe(buttons()[0]);
  });

  it("states why a disabled action is disabled, in TEXT, and does nothing when clicked", () => {
    const onClick = vi.fn();
    render({
      secondaryAction: {
        label: "Suspend",
        onClick,
        disabled: true,
        hint: "Untick the delete to suspend it",
      },
    });

    const secondary = buttons()[1];
    expect(secondary.disabled).toBe(true);
    // On screen, not in a `title`: the shipping webviews suppress pointer
    // events on disabled controls, so a tooltip there is never shown — which
    // is exactly the "reads as broken" outcome the hint exists to prevent.
    expect(document.querySelector(".confirm__hint")?.textContent).toBe(
      "Untick the delete to suspend it",
    );
    act(() => secondary.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("says nothing while the action is usable", () => {
    render({
      secondaryAction: {
        label: "Suspend",
        onClick: vi.fn(),
        hint: "Untick the delete to suspend it",
      },
    });
    expect(document.querySelector(".confirm__hint")).toBeNull();
  });
});

describe("ConfirmDialog — a held key dismisses once", () => {
  let root: Root;

  beforeEach(() => {
    baseProps.onCancel.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() =>
      root.render(createElement(ConfirmDialog, { ...baseProps })),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const escape = (repeat: boolean) =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", repeat }),
      );
    });

  it("ignores the auto-repeat of a held Escape", () => {
    // Notices queue behind one another, so a repeat would dismiss one the
    // user never saw: the dialog's text swaps in place while their finger is
    // still down. One press, one dismissal.
    escape(false);
    escape(true);
    escape(true);
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it("still answers a second, deliberate press", () => {
    escape(false);
    escape(false);
    expect(baseProps.onCancel).toHaveBeenCalledTimes(2);
  });
});
