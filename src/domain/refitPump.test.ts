import { describe, it, expect, vi } from "vitest";
import { createRefitPump, type RefitPumpOptions } from "./refitPump";

/**
 * Manual schedulers: frames and timers fire only when the test says so, so
 * the coalescing/settling behavior is asserted without real time.
 */
function harness(overrides: Partial<RefitPumpOptions> = {}) {
  const fit = vi.fn();
  const syncPty = vi.fn();
  let frameCb: (() => void) | null = null;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;

  const pump = createRefitPump({
    fit,
    syncPty,
    settleMs: 175,
    raf: (cb) => {
      frameCb = cb;
      return 1;
    },
    cancelRaf: () => {
      frameCb = null;
    },
    setTimer: (cb) => {
      const id = nextTimer++;
      timers.set(id, cb);
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    ...overrides,
  });

  const fireFrame = () => {
    const cb = frameCb;
    frameCb = null;
    cb?.();
  };
  const fireTimers = () => {
    const due = [...timers.values()];
    timers.clear();
    due.forEach((cb) => cb());
  };

  return { pump, fit, syncPty, fireFrame, fireTimers, timers };
}

describe("createRefitPump", () => {
  it("coalesces a burst of requests into one fit per frame", () => {
    const h = harness();
    h.pump.request();
    h.pump.request();
    h.pump.request();
    expect(h.fit).not.toHaveBeenCalled(); // nothing until the frame

    h.fireFrame();
    expect(h.fit).toHaveBeenCalledOnce();
  });

  it("fits again on the next frame of an ongoing drag", () => {
    const h = harness();
    h.pump.request();
    h.fireFrame();
    h.pump.request();
    h.fireFrame();
    expect(h.fit).toHaveBeenCalledTimes(2);
  });

  it("notifies the PTY once, only after the size settles", () => {
    const h = harness();
    h.pump.request();
    h.fireFrame();
    expect(h.syncPty).not.toHaveBeenCalled(); // still settling

    h.fireTimers();
    expect(h.syncPty).toHaveBeenCalledOnce();
  });

  it("restarts the settle window on every fit — a drag ends in one SIGWINCH", () => {
    const h = harness();
    h.pump.request();
    h.fireFrame(); // schedules settle timer #1
    h.pump.request();
    h.fireFrame(); // must cancel #1, schedule #2

    expect(h.timers.size).toBe(1); // the stale timer is gone, not queued
    h.fireTimers();
    expect(h.syncPty).toHaveBeenCalledOnce();
  });

  it("dispose cancels the pending frame and settle timer", () => {
    const h = harness();
    h.pump.request();
    h.fireFrame(); // settle timer now pending
    h.pump.request(); // frame now pending
    h.pump.dispose();

    h.fireFrame();
    h.fireTimers();
    expect(h.fit).toHaveBeenCalledOnce(); // only the pre-dispose fit
    expect(h.syncPty).not.toHaveBeenCalled();
  });

  it("ignores requests after dispose", () => {
    const h = harness();
    h.pump.dispose();
    h.pump.request();
    h.fireFrame();
    expect(h.fit).not.toHaveBeenCalled();
  });
});
