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

function mount(handler: () => void, enabled?: boolean) {
  root ??= createRoot(document.createElement("div"));
  function Probe() {
    useEscape(handler, enabled);
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
    expect(event.defaultPrevented).toBe(false);
  });

  it("declines the press outright when the surface is not taking Escape", () => {
    const handler = vi.fn();
    mount(handler, false);

    const event = press();

    expect(handler).not.toHaveBeenCalled();
    // The point is the second assertion. Guarding inside the closure still
    // cancelled the press, so a form with no cancel to run — the first-run
    // workspace screen — swallowed Escape window-wide and dismissed nothing.
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
