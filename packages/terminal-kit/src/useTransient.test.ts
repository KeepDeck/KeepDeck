// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTransient } from "./useTransient";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const MS = 4000;

// Captured from the probe render so tests can drive the hook from outside.
let show: (value: string) => void;

function Probe() {
  const [value, s] = useTransient<string>(MS);
  show = s;
  return createElement("div", null, value ?? "");
}

describe("useTransient", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("shows the value, then clears it after the timeout", () => {
    act(() => show("File not found: /a"));
    expect(host.textContent).toBe("File not found: /a");

    act(() => vi.advanceTimersByTime(MS - 1));
    expect(host.textContent).toBe("File not found: /a");

    act(() => vi.advanceTimersByTime(1));
    expect(host.textContent).toBe("");
  });

  it("restarts the countdown when a new value replaces a pending one", () => {
    act(() => show("first"));
    act(() => vi.advanceTimersByTime(MS - 1));
    act(() => show("second"));

    // The first timer must not clear the replacement early...
    act(() => vi.advanceTimersByTime(MS - 1));
    expect(host.textContent).toBe("second");

    // ...and the replacement still expires on its own full schedule.
    act(() => vi.advanceTimersByTime(1));
    expect(host.textContent).toBe("");
  });

  it("cancels the pending countdown on unmount", () => {
    act(() => show("pending"));
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    // re-create so afterEach's unmount is a no-op rather than a double-unmount.
    root = createRoot(host);
  });
});
