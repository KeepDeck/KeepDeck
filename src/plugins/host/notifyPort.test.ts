import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@keepdeck/plugin-api";
import {
  composePluginNotification,
  createPluginNotifyPort,
} from "./notifyPort";

function manifest(withCapability = true): PluginManifest {
  return {
    id: "keepdeck.git",
    name: "Git",
    version: "1.0.0",
    minApiVersion: 18,
    category: "deck",
    capabilities: withCapability ? [{ kind: "notifications" }] : [],
    contributes: {},
  } as unknown as PluginManifest;
}

describe("createPluginNotifyPort", () => {
  const deliver = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    deliver.mockClear();
    log.warn.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  const port = (over: Partial<Parameters<typeof createPluginNotifyPort>[1]> = {}) =>
    createPluginNotifyPort(manifest(), {
      mode: "enforce",
      log,
      deliver,
      ...over,
    });

  it("delivers a sanitized payload with the host-owned plugin id and namespaced tag", () => {
    port()({
      title: "  merge conflict  ",
      body: "in repo x",
      severity: "warning",
      wsId: "ws-1",
      dockTab: "git",
      tag: "conflict",
    });
    expect(deliver).toHaveBeenCalledWith({
      pluginId: "keepdeck.git",
      title: "merge conflict",
      body: "in repo x",
      severity: "warning",
      wsId: "ws-1",
      dockTab: "git",
      tag: "plugin:keepdeck.git:conflict",
    });
  });

  it("strips control, newline and bidi codepoints that could detach the attribution prefix", () => {
    port()({
      title: "  Session expired‮ — re-enter your password",
      body: "line1\nline2\r\nline3 end",
    });
    const d = deliver.mock.calls[0][0];
    expect(d.title).toBe("Session expired — re-enter your password");
    expect(d.body).toBe("line1 line2 line3 end");
  });

  it("a title that is ONLY unsafe codepoints counts as empty and drops", () => {
    port()({ title: "‮\n" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("undeclared capability: enforce throws, warn logs and proceeds", () => {
    const enforce = createPluginNotifyPort(manifest(false), {
      mode: "enforce",
      log,
      deliver,
    });
    expect(() => enforce({ title: "x" })).toThrow(/notifications/);
    expect(deliver).not.toHaveBeenCalled();

    const warn = createPluginNotifyPort(manifest(false), {
      mode: "warn",
      log,
      deliver,
    });
    warn({ title: "x" });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("capability"));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("mute drops silently before any token spend or logging", () => {
    let muted = true;
    const notify = port({ muted: () => muted });
    for (let i = 0; i < 10; i += 1) notify({ title: `spam ${i}` });
    expect(deliver).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    // Unmuting reveals a FULL bucket — the muted flood spent nothing.
    muted = false;
    notify({ title: "a" });
    notify({ title: "b" });
    notify({ title: "c" });
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it("junk survives: invalid inputs drop (and still spend the attempt's token)", () => {
    const notify = port();
    notify(null as never);
    notify({ title: "   " });
    notify({ title: 42 } as never);
    expect(deliver).not.toHaveBeenCalled();
    // Three invalid attempts drained the burst — the next VALID call is
    // rate-limited: garbage costs the plugin its own budget.
    notify({ title: "valid" });
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    notify({ title: "valid" });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("junk fields degrade alone and lengths cap", () => {
    port()({
      title: "t".repeat(500),
      body: 13,
      severity: "loud",
      wsId: "",
      tag: "g".repeat(200),
    } as never);
    const d = deliver.mock.calls[0][0];
    expect(d.title).toHaveLength(120);
    expect(d.body).toBeUndefined();
    expect(d.severity).toBe("info");
    expect(d.wsId).toBeUndefined();
    expect(d.tag).toBe(`plugin:keepdeck.git:${"g".repeat(64)}`);
  });

  it("token bucket: a burst of 3 passes, overflow drops, refill releases", () => {
    const notify = port();
    for (let i = 0; i < 5; i += 1) notify({ title: `n${i}` });
    expect(deliver).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(10_000); // one token back
    notify({ title: "after refill" });
    notify({ title: "still dry" });
    expect(deliver).toHaveBeenCalledTimes(4);
    expect(deliver.mock.calls[3][0].title).toBe("after refill");

    vi.advanceTimersByTime(60_000); // refill caps at the burst, not beyond
    for (let i = 0; i < 5; i += 1) notify({ title: `m${i}` });
    expect(deliver).toHaveBeenCalledTimes(7);
  });

  it("complaint logging is throttled: a drop-loop writes one line per window, with a count", () => {
    const notify = port();
    for (let i = 0; i < 3; i += 1) notify({ title: `n${i}` }); // drain burst
    for (let i = 0; i < 50; i += 1) notify({ title: "flood" }); // 50 drops
    expect(log.warn).toHaveBeenCalledTimes(1); // one line, not 50
    vi.advanceTimersByTime(10_000);
    notify({ title: "ok again" }); // token refilled — delivered, no warn
    notify({ title: "dry" }); // dry again → next window's single warn
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1][0]).toContain("+49 more suppressed");
  });
});

describe("composePluginNotification", () => {
  it("prefixes the sender's name and builds the plugin source", () => {
    expect(
      composePluginNotification("Git", {
        pluginId: "keepdeck.git",
        title: "merge conflict",
        body: "repo x",
        severity: "warning",
        wsId: "ws-1",
        dockTab: "git",
        tag: "plugin:keepdeck.git:conflict",
      }),
    ).toEqual({
      title: "Git · merge conflict",
      body: "repo x",
      severity: "warning",
      source: {
        type: "plugin",
        pluginId: "keepdeck.git",
        wsId: "ws-1",
        dockTab: "git",
      },
      tag: "plugin:keepdeck.git:conflict",
    });
  });

  it("absent optional fields stay undefined for every consumer", () => {
    const composed = composePluginNotification("Git", {
      pluginId: "keepdeck.git",
      title: "t",
      severity: "info",
    });
    expect(composed).toEqual({
      title: "Git · t",
      severity: "info",
      source: { type: "plugin", pluginId: "keepdeck.git" },
    });
    expect(composed.body).toBeUndefined();
    expect(composed.tag).toBeUndefined();
    expect(composed.source.wsId).toBeUndefined();
  });
});
