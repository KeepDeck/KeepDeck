// FIRST, before anything that reaches the mocked IPC — see testSupport.
import { HOST, resetCoreCommandTestState, setup, workspace } from "./testSupport";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  resetCoreCommandTestState();
});

describe("settings.open", () => {
  it("opens a plugin's own section, and the first section for anyone else", async () => {
    const { registry, openSettings } = setup([workspace({})]);
    await registry.execute("settings.open", {}, {
      kind: "plugin",
      pluginId: "keepdeck.voice",
    });
    expect(openSettings).toHaveBeenCalledWith("plugin:keepdeck.voice");

    await registry.execute("settings.open", {}, HOST);
    expect(openSettings).toHaveBeenLastCalledWith(null);
  });

  it("reports a refusal instead of claiming it opened over another dialog", async () => {
    // A command arrives with no button to have been disabled, so the host
    // gate is the only thing standing between it and a stacked dialog. When
    // it refuses, saying `{opened: true}` would tell a plugin a surface is up
    // that is not — and stacking is what gives one Escape two layers to peel.
    const { registry, openSettings } = setup([workspace({})]);
    openSettings.mockReturnValue(false);

    const result = await registry.execute("settings.open", {}, HOST);

    expect(result.ok).toBe(false);
    expect(openSettings).toHaveBeenCalledOnce();
  });
});

describe("usage.open", () => {
  it("opens the global usage statistics surface", async () => {
    const { registry, openUsage } = setup([workspace({})]);
    const result = await registry.execute("usage.open", {}, HOST);

    expect(result).toEqual({ ok: true, value: { opened: true } });
    expect(openUsage).toHaveBeenCalledOnce();
  });

  it("reports a refusal instead of claiming it opened over another dialog", async () => {
    const { registry, openUsage } = setup([workspace({})]);
    openUsage.mockReturnValue(false);

    const result = await registry.execute("usage.open", {}, HOST);

    expect(result.ok).toBe(false);
  });
});
