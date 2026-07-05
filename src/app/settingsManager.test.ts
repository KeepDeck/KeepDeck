import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from "../domain/settings";
import {
  getSettings,
  initSettings,
  resetSettingsManager,
  subscribeSettings,
  updateSettings,
} from "./settingsManager";

const ipc = vi.hoisted(() => ({
  loadSettings: vi.fn<() => Promise<string | null>>(),
  saveSettings: vi.fn<(json: string) => Promise<void>>(() => Promise.resolve()),
  quarantineSettings: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("../ipc/settings", () => ipc);

/** Let the queued save chain settle (each save is a macrotask-free chain,
 * so draining microtasks is enough). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("settingsManager", () => {
  beforeEach(() => {
    ipc.loadSettings.mockReset();
    ipc.saveSettings.mockClear();
    ipc.saveSettings.mockImplementation(() => Promise.resolve());
    ipc.quarantineSettings.mockClear();
    resetSettingsManager();
  });

  afterEach(() => resetSettingsManager());

  it("is null until the load settles — the paint gate", async () => {
    let resolveLoad!: (json: string | null) => void;
    ipc.loadSettings.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const booted = initSettings();
    expect(getSettings()).toBeNull();

    resolveLoad(null);
    await booted;
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("repeated init shares one load", async () => {
    ipc.loadSettings.mockResolvedValue(null);
    await Promise.all([initSettings(), initSettings()]);
    expect(ipc.loadSettings).toHaveBeenCalledTimes(1);
  });

  it("exposes the stored values once loaded", async () => {
    ipc.loadSettings.mockResolvedValue(
      JSON.stringify({ version: 1, scrollback: 30_000 }),
    );
    await initSettings();
    expect(getSettings()).toEqual({ ...DEFAULT_SETTINGS, scrollback: 30_000 });
    // Loading alone must not write — a boot must not touch the file.
    expect(ipc.saveSettings).not.toHaveBeenCalled();
  });

  it("quarantines an unusable file and runs on defaults", async () => {
    ipc.loadSettings.mockResolvedValue("{typo");
    await initSettings();
    expect(ipc.quarantineSettings).toHaveBeenCalledTimes(1);
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("runs on defaults when the load itself fails", async () => {
    ipc.loadSettings.mockRejectedValue(new Error("io"));
    await initSettings();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(ipc.quarantineSettings).not.toHaveBeenCalled();
  });

  it("update before the load settles is a no-op", () => {
    ipc.loadSettings.mockReturnValue(new Promise(() => {}));
    void initSettings();
    updateSettings({ scrollback: 20_000 });
    expect(getSettings()).toBeNull();
    expect(ipc.saveSettings).not.toHaveBeenCalled();
  });

  it("update applies at once and writes the sparse document through", async () => {
    ipc.loadSettings.mockResolvedValue(null);
    await initSettings();

    updateSettings({ defaultAgent: "opencode" });
    expect(getSettings()?.defaultAgent).toBe("opencode");
    await flush();
    expect(ipc.saveSettings).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ipc.saveSettings.mock.calls[0][0])).toEqual({
      version: SETTINGS_VERSION,
      minVersion: 1,
      defaultAgent: "opencode",
    });
  });

  it("same-tick updates chain — the last write carries both", async () => {
    ipc.loadSettings.mockResolvedValue(null);
    await initSettings();

    updateSettings({ scrollback: 20_000 });
    updateSettings({ defaultAgent: "codex" });
    await flush();
    const calls = ipc.saveSettings.mock.calls;
    const last = calls[calls.length - 1][0];
    expect(JSON.parse(last)).toEqual({
      version: SETTINGS_VERSION,
      minVersion: 1,
      scrollback: 20_000,
      defaultAgent: "codex",
    });
  });

  it("a failed save doesn't wedge the chain — the next change still writes", async () => {
    ipc.loadSettings.mockResolvedValue(null);
    await initSettings();

    ipc.saveSettings.mockRejectedValueOnce(new Error("disk full"));
    updateSettings({ scrollback: 20_000 });
    await flush();
    updateSettings({ scrollback: 25_000 });
    await flush();
    expect(ipc.saveSettings).toHaveBeenCalledTimes(2);
    expect(JSON.parse(ipc.saveSettings.mock.calls[1][0]).scrollback).toBe(25_000);
  });

  it("preserves a stored unknown key across an update", async () => {
    ipc.loadSettings.mockResolvedValue(
      JSON.stringify({ version: 1, futureToggle: true }),
    );
    await initSettings();

    updateSettings({ scrollback: 20_000 });
    await flush();
    const saved = JSON.parse(ipc.saveSettings.mock.calls[0][0]);
    expect(saved.futureToggle).toBe(true);
  });

  it("notifies subscribers on load and on update; unsubscribing stops", async () => {
    ipc.loadSettings.mockResolvedValue(null);
    const seen: (number | undefined)[] = [];
    const unsubscribe = subscribeSettings(() =>
      seen.push(getSettings()?.scrollback),
    );

    await initSettings();
    updateSettings({ scrollback: 20_000 });
    expect(seen).toEqual([DEFAULT_SETTINGS.scrollback, 20_000]);

    unsubscribe();
    updateSettings({ scrollback: 25_000 });
    expect(seen).toHaveLength(2);
  });
});
