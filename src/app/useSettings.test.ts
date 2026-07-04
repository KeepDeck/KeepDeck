// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../domain/settings";
import { useSettings, type SettingsStore } from "./useSettings";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ipc = vi.hoisted(() => ({
  loadSettings: vi.fn<() => Promise<string | null>>(),
  saveSettings: vi.fn<(json: string) => Promise<void>>(() => Promise.resolve()),
  quarantineSettings: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("../ipc/settings", () => ipc);

let store: SettingsStore;

function Probe() {
  store = useSettings();
  return null;
}

describe("useSettings", () => {
  let root: Root;

  beforeEach(() => {
    ipc.loadSettings.mockReset();
    ipc.saveSettings.mockClear();
    ipc.saveSettings.mockImplementation(() => Promise.resolve());
    ipc.quarantineSettings.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const mount = async () => {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {}); // let the load promise chain settle
  };

  it("is null until the load settles — the paint gate", async () => {
    let resolveLoad!: (json: string | null) => void;
    ipc.loadSettings.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    await mount();
    expect(store.settings).toBeNull();

    await act(async () => resolveLoad(null));
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("exposes the stored values once loaded", async () => {
    ipc.loadSettings.mockResolvedValue(
      JSON.stringify({ version: 1, scrollback: 30_000 }),
    );
    await mount();
    expect(store.settings).toEqual({ ...DEFAULT_SETTINGS, scrollback: 30_000 });
    // Loading alone must not write — a boot must not touch the file.
    expect(ipc.saveSettings).not.toHaveBeenCalled();
  });

  it("quarantines an unusable file and runs on defaults", async () => {
    ipc.loadSettings.mockResolvedValue("{typo");
    await mount();
    expect(ipc.quarantineSettings).toHaveBeenCalledTimes(1);
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("runs on defaults when the load itself fails", async () => {
    ipc.loadSettings.mockRejectedValue(new Error("io"));
    await mount();
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
    expect(ipc.quarantineSettings).not.toHaveBeenCalled();
  });

  it("update applies at once and writes the sparse document through", async () => {
    ipc.loadSettings.mockResolvedValue(null);
    await mount();

    act(() => store.update({ confirmBeforeClose: false }));
    expect(store.settings?.confirmBeforeClose).toBe(false);
    await act(async () => {});
    expect(ipc.saveSettings).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ipc.saveSettings.mock.calls[0][0])).toEqual({
      version: 1,
      confirmBeforeClose: false,
    });
  });

  it("same-tick updates chain — the last write carries both", async () => {
    ipc.loadSettings.mockResolvedValue(null);
    await mount();

    act(() => {
      store.update({ scrollback: 20_000 });
      store.update({ defaultAgent: "codex" });
    });
    await act(async () => {});
    const calls = ipc.saveSettings.mock.calls;
    const last = calls[calls.length - 1][0];
    expect(JSON.parse(last)).toEqual({
      version: 1,
      scrollback: 20_000,
      defaultAgent: "codex",
    });
  });

  it("a failed save doesn't wedge the chain — the next change still writes", async () => {
    ipc.loadSettings.mockResolvedValue(null);
    await mount();

    ipc.saveSettings.mockRejectedValueOnce(new Error("disk full"));
    act(() => store.update({ scrollback: 20_000 }));
    await act(async () => {});
    act(() => store.update({ scrollback: 25_000 }));
    await act(async () => {});
    expect(ipc.saveSettings).toHaveBeenCalledTimes(2);
    expect(JSON.parse(ipc.saveSettings.mock.calls[1][0]).scrollback).toBe(25_000);
  });

  it("preserves a stored unknown key across an update", async () => {
    ipc.loadSettings.mockResolvedValue(
      JSON.stringify({ version: 1, futureToggle: true }),
    );
    await mount();

    act(() => store.update({ scrollback: 20_000 }));
    await act(async () => {});
    const saved = JSON.parse(ipc.saveSettings.mock.calls[0][0]);
    expect(saved.futureToggle).toBe(true);
  });
});
