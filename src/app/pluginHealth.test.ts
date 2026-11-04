import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLUGIN_CRASHES_KEPT,
  clearPluginCrashes,
  pluginCrashes,
  reportPluginCrash,
  subscribePluginCrashes,
} from "./pluginHealth";

afterEach(() => {
  for (const crash of [...pluginCrashes()]) clearPluginCrashes(crash.pluginId);
});

describe("pluginHealth", () => {
  it("records a crash with its surface and an Error's stack", () => {
    const error = new Error("render died");
    reportPluginCrash("keepdeck.files", "overlay", "viewer", error);
    const [crash] = pluginCrashes();
    expect(crash.pluginId).toBe("keepdeck.files");
    expect(crash.surfaceKind).toBe("overlay");
    expect(crash.surfaceId).toBe("viewer");
    expect(crash.detail).toContain("render died");
  });

  it("keeps a stable snapshot between changes and a new one after each", () => {
    const before = pluginCrashes();
    expect(pluginCrashes()).toBe(before);
    reportPluginCrash("p", "tab", "t", "boom");
    const after = pluginCrashes();
    expect(after).not.toBe(before);
    expect(pluginCrashes()).toBe(after);
  });

  it("clear forgets ONE plugin's crashes and leaves the neighbour's", () => {
    reportPluginCrash("a", "tab", "t", "x");
    reportPluginCrash("b", "tab", "t", "y");
    clearPluginCrashes("a");
    expect(pluginCrashes().map((c) => c.pluginId)).toEqual(["b"]);
    // Clearing a plugin with no records changes (and notifies) nothing.
    const snapshot = pluginCrashes();
    clearPluginCrashes("a");
    expect(pluginCrashes()).toBe(snapshot);
  });

  it("keeps a looping plugin's newest crashes only, and never a neighbour's out", () => {
    reportPluginCrash("b", "tab", "t", "the neighbour's one crash");
    for (let i = 0; i < PLUGIN_CRASHES_KEPT + 5; i++) {
      reportPluginCrash("a", "tab", "t", `crash ${i}`);
    }
    const looping = pluginCrashes().filter((c) => c.pluginId === "a").map((c) => c.detail);
    expect(looping).toHaveLength(PLUGIN_CRASHES_KEPT);
    expect(looping[0]).toBe("crash 5");
    expect(looping[looping.length - 1]).toBe(`crash ${PLUGIN_CRASHES_KEPT + 4}`);
    expect(pluginCrashes().filter((c) => c.pluginId === "b").map((c) => c.detail)).toEqual([
      "the neighbour's one crash",
    ]);
  });

  it("notifies subscribers on report and clear, stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePluginCrashes(listener);
    reportPluginCrash("p", "tab", "t", "x");
    clearPluginCrashes("p");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    reportPluginCrash("p", "tab", "t", "x");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
