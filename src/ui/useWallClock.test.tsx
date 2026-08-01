// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWallClock } from "./useWallClock";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

function Probe({ atLeast, out }: { atLeast?: number; out: { now: number } }) {
  out.now = useWallClock(atLeast);
  return null;
}

describe("useWallClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  it("holds a stable now between ticks and advances on the slow tick", () => {
    const out = { now: 0 };
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(Probe, { out })));
    expect(out.now).toBe(1_000_000);
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(out.now).toBe(1_030_000);
  });

  it("never trails the data it times: atLeast floors the returned now", () => {
    const out = { now: 0 };
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(Probe, { out })));
    // A ledger append lands 5s after the last tick — the surface passes the
    // event's instant, and now may not read earlier than the data.
    act(() => root!.render(createElement(Probe, { atLeast: 1_005_000, out })));
    expect(out.now).toBe(1_005_000);
    // The next tick overtakes the floor and wall time wins again.
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(out.now).toBe(1_030_000);
  });
});
