import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@keepdeck/plugin-api";
import { createPluginNotifyPort } from "./notifyPort";

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

  it("delivers a sanitized payload with the host-owned plugin id and namespaced tag", () => {
    const notify = createPluginNotifyPort(manifest(), {
      mode: "enforce",
      log,
      deliver,
    });
    notify({
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

  it("junk survives: missing title drops, junk fields degrade, lengths cap", () => {
    const notify = createPluginNotifyPort(manifest(), {
      mode: "enforce",
      log,
      deliver,
    });
    notify(null as never);
    notify({ title: "   " });
    notify({ title: 42 } as never);
    expect(deliver).not.toHaveBeenCalled();

    notify({
      title: "t".repeat(500),
      body: 13,
      severity: "loud",
      wsId: "",
      tag: "g".repeat(200),
    } as never);
    const delivered = deliver.mock.calls[0][0];
    expect(delivered.title).toHaveLength(120);
    expect(delivered.body).toBeUndefined();
    expect(delivered.severity).toBe("info");
    expect(delivered.wsId).toBeUndefined();
    expect(delivered.tag).toBe(`plugin:keepdeck.git:${"g".repeat(64)}`);
  });

  it("token bucket: a burst of 3 passes, overflow drops and logs, refill releases", () => {
    const notify = createPluginNotifyPort(manifest(), {
      mode: "enforce",
      log,
      deliver,
    });
    for (let i = 0; i < 5; i += 1) notify({ title: `n${i}` });
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("rate limit"));

    vi.advanceTimersByTime(10_000); // one token back
    notify({ title: "after refill" });
    notify({ title: "still dry" });
    expect(deliver).toHaveBeenCalledTimes(4);
    expect(deliver.mock.calls[3][0].title).toBe("after refill");

    vi.advanceTimersByTime(60_000); // refill caps at the burst, not beyond
    for (let i = 0; i < 5; i += 1) notify({ title: `m${i}` });
    expect(deliver).toHaveBeenCalledTimes(7);
  });
});
