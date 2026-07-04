// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperimentsSection } from "./ExperimentsSection";
import {
  getSettings,
  initSettings,
  resetSettingsManager,
} from "../../app/settingsManager";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Real settings manager over a mocked IPC — the toggle must round-trip
// through the store, not just flip local state.
vi.mock("../../ipc/settings", () => ({
  loadSettings: async () => null,
  saveSettings: async () => {},
  quarantineSettings: async () => {},
}));

describe("ExperimentsSection", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    resetSettingsManager();
    await initSettings();
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    resetSettingsManager();
  });

  it("run presets start OFF and the toggle writes the setting through", () => {
    act(() => root.render(createElement(ExperimentsSection)));

    const box = document.querySelector<HTMLInputElement>(
      'input[aria-label="Enable run presets"]',
    )!;
    expect(box.checked).toBe(false);

    act(() => box.click());
    expect(getSettings()?.experimentRunPresets).toBe(true);
    expect(box.checked).toBe(true);

    act(() => box.click());
    expect(getSettings()?.experimentRunPresets).toBe(false);
  });
});
