import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
    reportPluginCrash("keepdeck.files", 'overlay "viewer"', error);
    const [crash] = pluginCrashes();
    expect(crash.pluginId).toBe("keepdeck.files");
    expect(crash.surface).toBe('overlay "viewer"');
    expect(crash.detail).toContain("render died");
  });

  it("keeps a stable snapshot between changes and a new one after each", () => {
    const before = pluginCrashes();
    expect(pluginCrashes()).toBe(before);
    reportPluginCrash("p", "tab", "boom");
    const after = pluginCrashes();
    expect(after).not.toBe(before);
    expect(pluginCrashes()).toBe(after);
  });

  it("clear forgets ONE plugin's crashes and leaves the neighbour's", () => {
    reportPluginCrash("a", "tab", "x");
    reportPluginCrash("b", "tab", "y");
    clearPluginCrashes("a");
    expect(pluginCrashes().map((c) => c.pluginId)).toEqual(["b"]);
    // Clearing a plugin with no records changes (and notifies) nothing.
    const snapshot = pluginCrashes();
    clearPluginCrashes("a");
    expect(pluginCrashes()).toBe(snapshot);
  });

  it("notifies subscribers on report and clear, stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePluginCrashes(listener);
    reportPluginCrash("p", "tab", "x");
    clearPluginCrashes("p");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    reportPluginCrash("p", "tab", "x");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
