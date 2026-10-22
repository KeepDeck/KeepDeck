import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Untyped resource JS — shipped to, and loaded by, the user's opencode.
// @ts-expect-error untyped resource module
import * as foreground from "../resources/keepdeck-plugin/foreground.js";
// @ts-expect-error untyped resource module
import observer, { observeRoute, routeOf } from "../resources/keepdeck-plugin/route-observer.js";

const { DEAD_MS, FOREGROUND_FILE, STALE_MS, readForeground, writeForeground } = foreground;

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
    let current: unknown = { name: "session", params: { sessionID: "ses_a" } };
    const api = { route: { get current() { return current; } } };
    const stop = observeRoute(api, dir, () => clock);
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
    current = { name: "home" };
    tick();
    current = { name: "session", params: { sessionID: "ses_a" } };
    tick();
    expect(read()).toEqual({ kind: "session", sessionID: "ses_a" });

    // Stayed: written.
    current = { name: "home" };
    tick();
    tick();
    expect(read()).toEqual({ kind: "home" });

    // Unchanged for a while, still fresh.
    for (let i = 0; i < 20; i++) tick();
    expect(read()).toEqual({ kind: "home" });
    stop();
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
