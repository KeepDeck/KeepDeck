// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  error: vi.fn(() => Promise.resolve()),
  warn: vi.fn(() => Promise.resolve()),
  info: vi.fn(() => Promise.resolve()),
  debug: vi.fn(() => Promise.resolve()),
  attachConsole: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/plugin-log", () => plugin);

import { describeError, initLogging, log } from "./log";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("log facade", () => {
  it("prefixes the target and ships to the matching level", () => {
    log.info("web:revive", "resume abc");
    log.warn("web:persist", "save failed");
    expect(plugin.info).toHaveBeenCalledWith("[web:revive] resume abc");
    expect(plugin.warn).toHaveBeenCalledWith("[web:persist] save failed");
  });

  it("survives a rejecting sink (no unhandled rejection)", async () => {
    plugin.error.mockImplementationOnce(() => Promise.reject(new Error("ipc down")));
    expect(() => log.error("web:window", "boom")).not.toThrow();
    // Let the swallowed rejection settle; an unhandled one would fail the run.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("survives a synchronously throwing sink (no Tauri host)", () => {
    plugin.debug.mockImplementationOnce(() => {
      throw new Error("window.__TAURI__ missing");
    });
    expect(() => log.debug("web:probe", "x")).not.toThrow();
  });
});

describe("describeError", () => {
  it("unwraps Error, passes strings through, dumps objects", () => {
    expect(describeError(new Error("nope"))).toBe("nope");
    expect(describeError("plain rejection")).toBe("plain rejection");
    expect(describeError({ code: 2 })).toBe('{"code":2}');
  });

  it("never throws on hostile values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof describeError(cyclic)).toBe("string");
    expect(describeError(undefined)).toBe("undefined");
  });
});

describe("initLogging", () => {
  it("routes uncaught window errors into the log", () => {
    initLogging();
    window.dispatchEvent(new ErrorEvent("error", { message: "ReferenceError: x" }));
    expect(plugin.error).toHaveBeenCalledWith(
      "[web:window] uncaught: ReferenceError: x",
    );
  });

  it("appends the thrown error's stack frames when it has them", () => {
    initLogging();
    const thrown = new Error("dims gone");
    thrown.stack = "syncScrollArea@app.js:10:5\n_innerRefresh@app.js:20:9";
    window.dispatchEvent(
      new ErrorEvent("error", { message: "TypeError: dims", error: thrown }),
    );
    expect(plugin.error).toHaveBeenCalledWith(
      "[web:window] uncaught: TypeError: dims\nsyncScrollArea@app.js:10:5\n_innerRefresh@app.js:20:9",
    );
  });

  it("caps stack depth and frame length so one bundled line can't flood", () => {
    initLogging();
    const thrown = new Error("deep");
    thrown.stack = [
      `top@${"x".repeat(500)}:1:1`,
      ...Array.from({ length: 20 }, (_, i) => `f${i}@app.js:${i}:1`),
    ].join("\n");
    window.dispatchEvent(
      new ErrorEvent("error", { message: "boom", error: thrown }),
    );
    const shipped = (plugin.error.mock.lastCall as unknown as [string])[0];
    const lines = shipped.split("\n");
    // Message line + at most 8 frames, none longer than its cap.
    expect(lines.length).toBe(9);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(lines[1].length).toBeLessThanOrEqual(201);
  });

  it("routes unhandled rejections into the log", () => {
    initLogging();
    const event = new Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = "spawn failed";
    window.dispatchEvent(event);
    expect(plugin.error).toHaveBeenCalledWith(
      "[web:window] unhandled rejection: spawn failed",
    );
  });

  it("appends the stack when a rejection's reason is an Error", () => {
    initLogging();
    const reason = new Error("plan rejected");
    reason.stack = "commitPlan@app.js:33:3";
    const event = new Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = reason;
    window.dispatchEvent(event);
    expect(plugin.error).toHaveBeenCalledWith(
      "[web:window] unhandled rejection: plan rejected\ncommitPlan@app.js:33:3",
    );
  });
});
