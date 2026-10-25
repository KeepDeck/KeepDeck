import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Resource JS — shipped to, and loaded by, the user's opencode.
import * as foreground from "../resources/keepdeck-plugin/foreground.js";
import observer, { routeOf } from "../resources/keepdeck-plugin/route-observer.js";

const { DEAD_MS, FOREGROUND_FILE, STALE_MS, observeRoute, readForeground, writeForeground } = foreground;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kd-foreground-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("what the server half reads", () => {
  const NOW = 1_000_000;
  const at = (age: number, route: Record<string, unknown>, pid = process.pid) =>
    writeForeground(dir, route, NOW - age, pid);

  it("trusts a fresh route of this process: a session, or none on screen", () => {
    at(0, { route: "session", sessionID: "ses_a" });
    expect(readForeground(dir, NOW)).toEqual({ kind: "session", sessionID: "ses_a" });
    at(0, { route: "home" });
    expect(readForeground(dir, NOW)).toEqual({ kind: "home" });
    at(0, { route: "other" });
    expect(readForeground(dir, NOW)).toEqual({ kind: "other" });
  });

  it("knows nothing when there is no observer for THIS process", () => {
    // Unknown means: deliver as before there was one.
    expect(readForeground(dir, NOW)).toEqual({ kind: "unknown" });
    at(0, { route: "home" }, process.pid + 1);
    expect(readForeground(dir, NOW)).toEqual({ kind: "unknown" });
    writeFileSync(join(dir, FOREGROUND_FILE), "{ torn");
    expect(readForeground(dir, NOW)).toEqual({ kind: "unknown" });
  });

  it("trusts the TUI it names — on 2.x that is its parent process, not itself", () => {
    const tui = process.pid + 1;
    at(0, { route: "home" }, tui);
    expect(readForeground(dir, NOW, tui)).toEqual({ kind: "home" });
    expect(readForeground(dir, NOW, process.pid)).toEqual({ kind: "unknown" });
  });

  it("holds while the TUI stops answering, and gives up holding once the observer is gone", () => {
    at(STALE_MS, { route: "home" });
    expect(readForeground(dir, NOW).kind).toBe("home");
    at(STALE_MS + 1, { route: "home" });
    expect(readForeground(dir, NOW)).toEqual({ kind: "stale" });
    // Holding mail forever behind a dead observer would be worse than the
    // bug it fixes.
    at(DEAD_MS + 1, { route: "home" });
    expect(readForeground(dir, NOW)).toEqual({ kind: "unknown" });
  });

  it("writes whole or not at all — nothing half-written is left behind", () => {
    writeForeground(dir, { route: "home" });
    expect(readdirSync(dir)).toEqual([FOREGROUND_FILE]);
  });
});

describe("the TUI half", () => {
  it("is a TUI plugin alone — 1.19.3 refuses a module with a server half too", () => {
    expect(typeof observer.id).toBe("string");
    expect(typeof observer.tui).toBe("function");
    expect(observer).not.toHaveProperty("server");
  });

  it("names the route as the server half reads it", () => {
    expect(routeOf({ name: "session", params: { sessionID: "ses_a" } })).toEqual({
      route: "session",
      sessionID: "ses_a",
    });
    expect(routeOf({ name: "home" })).toEqual({ route: "home" });
    // A plugin's own screen: no session, and not the home screen either.
    expect(routeOf({ name: "kd-settings" })).toEqual({ route: "other" });
    expect(routeOf(undefined)).toEqual({ route: "other" });
  });

  it("writes a route once it held for two polls, then keeps a heartbeat", () => {
    vi.useFakeTimers();
    let clock = 5_000;
    let current: Record<string, unknown> = { route: "session", sessionID: "ses_a" };
    const stop = observeRoute(() => current, dir, () => clock);
    const read = () => readForeground(dir, clock);
    const tick = () => {
      clock += 250;
      vi.advanceTimersByTime(250);
    };

    tick();
    expect(read()).toEqual({ kind: "unknown" });
    tick();
    expect(read()).toEqual({ kind: "session", sessionID: "ses_a" });

    // Passed through for one poll: not somewhere the user went.
    current = { route: "home" };
    tick();
    current = { route: "session", sessionID: "ses_a" };
    tick();
    expect(read()).toEqual({ kind: "session", sessionID: "ses_a" });

    // Stayed: written.
    current = { route: "home" };
    tick();
    tick();
    expect(read()).toEqual({ kind: "home" });

    // Unchanged for a while, still fresh.
    for (let i = 0; i < 20; i++) tick();
    expect(read()).toEqual({ kind: "home" });

    stop();
  });

  it("skips a poll whose read throws, and leaves the record as it was", () => {
    vi.useFakeTimers();
    let clock = 5_000;
    let fail = false;
    const stop = observeRoute(() => {
      if (fail) throw new Error("the TUI is going");
      return { route: "home" };
    }, dir, () => clock);
    const tick = () => {
      clock += 250;
      vi.advanceTimersByTime(250);
    };
    tick();
    tick();
    fail = true;
    for (let i = 0; i < 14; i++) tick();
    // No heartbeat while the read fails: the record ages toward stale.
    expect(readForeground(dir, clock)).toEqual({ kind: "stale" });
    stop();
  });

  it("in a KeepDeck pane, writes the route opencode shows, and stops on dispose", async () => {
    vi.useFakeTimers();
    const before = process.env.KEEPDECK_BRIDGE;
    process.env.KEEPDECK_BRIDGE = JSON.stringify({ v: 2, dir, pane: "pane-1", token: "t", url: "http://127.0.0.1:9/envelope" });
    try {
      let current: unknown = { name: "session", params: { sessionID: "ses_a" } };
      let dispose: (() => void) | undefined;
      await observer.tui({
        route: { get current() { return current; } },
        lifecycle: { onDispose: (stop: () => void) => { dispose = stop; } },
      });
      vi.advanceTimersByTime(500);
      expect(readForeground(dir)).toEqual({ kind: "session", sessionID: "ses_a" });

      dispose?.();
      current = { name: "home" };
      vi.advanceTimersByTime(500);
      expect(readForeground(dir)).toEqual({ kind: "session", sessionID: "ses_a" });
    } finally {
      if (before === undefined) delete process.env.KEEPDECK_BRIDGE;
      else process.env.KEEPDECK_BRIDGE = before;
    }
  });

  it("stays inert outside a KeepDeck pane", async () => {
    const before = process.env.KEEPDECK_BRIDGE;
    delete process.env.KEEPDECK_BRIDGE;
    const onDispose = vi.fn();
    await observer.tui({ route: { current: { name: "home" } }, lifecycle: { onDispose } });
    expect(onDispose).not.toHaveBeenCalled();
    if (before !== undefined) process.env.KEEPDECK_BRIDGE = before;
  });
});
