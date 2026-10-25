import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Resource JS — shipped to, and loaded by, the user's opencode.
import { readForeground } from "../resources/keepdeck-plugin/foreground.js";
import { SHOW_FILE, SHOW_FRESH_MS, requestShow, takeShowRequest } from "../resources/keepdeck-plugin/show-request.js";
import tuiPlugin, { routeOfV2 } from "../resources/keepdeck-plugin/tui.js";

/**
 * KeepDeck's opencode 2.x TUI half (tui.js, task-436): it reports the screen
 * and shows the session the courier made for mail — only on the home screen.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kd-tui2-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const inPane = () =>
  vi.stubEnv("KEEPDECK_BRIDGE", JSON.stringify({ v: 2, dir, pane: "pane-1", token: "t", url: "http://127.0.0.1:9/envelope" }));

/** A 2.x TUI router: `current()` and `navigate()`, as the plugin context
 * hands them over (packages/plugin/src/tui/context.ts). */
const routerAt = (first: unknown) => {
  let current = first;
  const navigated: unknown[] = [];
  return {
    navigated,
    go: (next: unknown) => {
      current = next;
    },
    router: {
      current: () => current,
      navigate: (destination: unknown) => {
        navigated.push(destination);
        current = destination;
      },
    },
  };
};

const startTui = (context: Parameters<typeof tuiPlugin.setup>[0]) => {
  const cleanup = tuiPlugin.setup(context);
  if (!cleanup) throw new Error("TUI plugin did not start in the test pane");
  return cleanup;
};

describe("the 2.x route, as the server half reads it", () => {
  it("names a session, the home screen, and anything else as no session", () => {
    expect(routeOfV2({ type: "session", sessionID: "ses_a" })).toEqual({ route: "session", sessionID: "ses_a" });
    expect(routeOfV2({ type: "home" })).toEqual({ route: "home" });
    // A plugin's own page: no session, and not the home screen either.
    expect(routeOfV2({ type: "plugin", id: "x", name: "y" })).toEqual({ route: "other" });
    expect(routeOfV2({ type: "session", sessionID: "" })).toEqual({ route: "other" });
    expect(routeOfV2(undefined)).toEqual({ route: "other" });
  });
});

describe("the 2.x TUI half in a pane", () => {
  it("writes the screen it shows, and stops when opencode cleans it up", () => {
    vi.useFakeTimers();
    inPane();
    const tui = routerAt({ type: "session", sessionID: "ses_a" });
    const cleanup = startTui({ ui: { router: tui.router } });
    vi.advanceTimersByTime(500);
    expect(readForeground(dir)).toEqual({ kind: "session", sessionID: "ses_a" });

    cleanup();
    tui.go({ type: "home" });
    vi.advanceTimersByTime(500);
    expect(readForeground(dir)).toEqual({ kind: "session", sessionID: "ses_a" });
  });

  it("shows the session the courier asked for while the home screen is up", () => {
    vi.useFakeTimers();
    inPane();
    const tui = routerAt({ type: "home" });
    const cleanup = startTui({ ui: { router: tui.router } });
    requestShow(dir, "ses_mail");
    vi.advanceTimersByTime(300);
    expect(tui.navigated).toEqual([{ type: "session", sessionID: "ses_mail" }]);
    expect(existsSync(join(dir, SHOW_FILE))).toBe(false);
    cleanup();
  });

  it("does not take the user away from a session they opened meanwhile — the request is dropped", () => {
    vi.useFakeTimers();
    inPane();
    const tui = routerAt({ type: "session", sessionID: "ses_theirs" });
    const cleanup = startTui({ ui: { router: tui.router } });
    requestShow(dir, "ses_mail");
    vi.advanceTimersByTime(300);
    expect(tui.navigated).toEqual([]);
    // Taken all the same: back home later, it is not obeyed then either.
    tui.go({ type: "home" });
    vi.advanceTimersByTime(300);
    expect(tui.navigated).toEqual([]);
    cleanup();
  });

  it("survives a router that throws", () => {
    vi.useFakeTimers();
    inPane();
    const cleanup = startTui({
      ui: {
        router: {
          current: () => {
            throw new Error("not ready");
          },
          navigate: () => {},
        },
      },
    });
    requestShow(dir, "ses_mail");
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();
    cleanup();
  });
});

describe("a request to show a session", () => {
  it("is taken once, while fresh", () => {
    requestShow(dir, "ses_a", 1_000);
    expect(takeShowRequest(dir, 1_000 + SHOW_FRESH_MS)).toBe("ses_a");
    expect(takeShowRequest(dir, 1_000 + SHOW_FRESH_MS)).toBeNull();
  });

  it("is refused — and removed — once stale, torn, or naming nobody", () => {
    requestShow(dir, "ses_a", 1_000);
    expect(takeShowRequest(dir, 1_001 + SHOW_FRESH_MS)).toBeNull();
    expect(existsSync(join(dir, SHOW_FILE))).toBe(false);

    writeFileSync(join(dir, SHOW_FILE), "{ torn");
    expect(takeShowRequest(dir)).toBeNull();
    expect(existsSync(join(dir, SHOW_FILE))).toBe(false);

    writeFileSync(join(dir, SHOW_FILE), JSON.stringify({ sessionID: "", at: Date.now() }));
    expect(takeShowRequest(dir)).toBeNull();
  });
});
