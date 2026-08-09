// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEscape } from "./useEscape";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function mount(handler: () => void) {
  root ??= createRoot(document.createElement("div"));
  function Probe() {
    useEscape(handler);
    return null;
  }
  act(() => root!.render(createElement(Probe)));
}

/** Dispatch one keydown on `window` and hand back the event, so a test can
 * read whether the press was consumed. */
function press(init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe("useEscape", () => {
  it("dismisses on Escape and CONSUMES the press", () => {
    const handler = vi.fn();
    mount(handler);

    const event = press();

    expect(handler).toHaveBeenCalledOnce();
    // The load-bearing half: an uncancelled Escape keydown still yields a
    // `keypress` in WebKit, and that one lands on the pane's terminal — which
    // has the keyboard back by then — and interrupts the agent.
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves an auto-repeat alone entirely — neither dismissed nor swallowed", () => {
    const handler = vi.fn();
    mount(handler);

    const event = press({ repeat: true });

    expect(handler).not.toHaveBeenCalled();
    // Not merely un-dismissed: this surface does not claim a key it refuses
    // to act on, so a held Escape belongs to whoever holds the keyboard once
    // the dialog is gone.
    expect(event.defaultPrevented).toBe(false);
  });

  it("claims nothing once the surface is gone", () => {
    const handler = vi.fn();
    mount(handler);
    act(() => root!.unmount());
    root = null;

    const event = press();

    expect(handler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
