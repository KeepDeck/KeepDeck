// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSettings,
  initSettings,
  resetSettingsManager,
  updateSettings,
} from "../../app/settingsManager";
import {
  DEFAULT_SETTINGS,
  SCROLLBACK_MIN,
  type Settings,
} from "../../domain/settings";
import { SettingsDialog } from "./SettingsDialog";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The dialog's sections talk to the real settings manager over a mocked IPC —
// the tests cover the whole loop: control → store → re-render.
const ipc = vi.hoisted(() => ({
  loadSettings: vi.fn<() => Promise<string | null>>(async () => null),
  saveSettings: vi.fn<(json: string) => Promise<void>>(async () => {}),
  quarantineSettings: vi.fn<() => Promise<void>>(async () => {}),
}));
vi.mock("../../ipc/settings", () => ipc);

// The General section assembles the agent catalog from the plugin registry
// (seeded with the three built-in cli agents) plus per-mount detection —
// detectBins is the refetch tripwire.
const agentsIpc = vi.hoisted(() => ({
  detectBins: vi.fn(async (bins: string[]) =>
    bins.map((bin) => ({ bin, installed: true, path: null })),
  ),
}));
vi.mock("../../ipc/agents", () => agentsIpc);
vi.mock("../../app/pluginManager", async () => {
  const { createContributionRegistries } = await import(
    "../../plugins/registries/contributions"
  );
  const registries = createContributionRegistries();
  for (const [id, label] of [
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    ["opencode", "OpenCode"],
  ]) {
    registries.agents.add("test-plugin", {
      id,
      label,
      detect: { bin: id },
      hooks: {},
    });
  }
  return {
    pluginRegistries: registries,
    bootstrapPlugins: () => Promise.resolve(),
    // The Plugins section renders in the dialog's nav tree — a quiet, empty
    // host keeps it inert without pulling the real Tauri-backed manager in.
    pluginHost: {
      // useSyncExternalStore compares snapshots by identity — return a
      // STABLE empty list, or the store loops forever.
      getInstalled: (() => {
        const none: never[] = [];
        return () => none;
      })(),
      subscribe: () => () => {},
      setEnabled: async () => {},
    },
    externalPluginInfo: () => null,
    rescanPlugins: async () => {},
    restartPlugin: async () => {},
  };
});

const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  )!;
const scrollbackInput = () =>
  document.querySelector<HTMLInputElement>(
    'input[aria-label="Terminal scrollback lines"]',
  );
/** The section panel an element lives in — visibility is per panel (`hidden`),
 * inactive sections stay mounted. */
const panelOf = (el: Element) => el.closest(".settings__section")!;

/** Type into a controlled React input: set via the native setter (bypassing
 * React's value tracker) and fire a bubbling `input` event. */
function type(el: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const blur = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

describe("SettingsDialog", () => {
  let root: Root;
  let closed: number;

  beforeEach(() => {
    ipc.saveSettings.mockClear();
    agentsIpc.detectBins.mockClear();
    resetSettingsManager();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    closed = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    resetSettingsManager();
  });

  const mount = async (overrides: Partial<Settings> = {}) => {
    await initSettings();
    if (Object.keys(overrides).length > 0) updateSettings(overrides);
    // Seeding writes aren't under test — let the queued save land, then drop it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    ipc.saveSettings.mockClear();
    await act(async () =>
      root.render(
        createElement(SettingsDialog, { onClose: () => closed++ }),
      ),
    );
    await act(async () => {}); // flush the agent-catalog load
  };

  const toTerminal = () => act(() => button("Terminal").click());

  it("opens on General; the nav switches which panel is visible", async () => {
    await mount();
    expect(panelOf(button("Claude Code")).hasAttribute("hidden")).toBe(false);
    expect(panelOf(scrollbackInput()!).hasAttribute("hidden")).toBe(true);
    expect(button("General").className).toContain("settings__nav-item--active");

    toTerminal();
    expect(panelOf(scrollbackInput()!).hasAttribute("hidden")).toBe(false);
    expect(panelOf(button("Claude Code")).hasAttribute("hidden")).toBe(true);
    expect(button("Terminal").className).toContain("settings__nav-item--active");
  });

  it("switching sections never refetches the agent catalog", async () => {
    // A remount would refetch and flash the General panel empty while the
    // IPC roundtrip runs — panels must stay mounted across switches.
    await mount();
    agentsIpc.detectBins.mockClear();
    toTerminal();
    act(() => button("General").click());
    expect(agentsIpc.detectBins).not.toHaveBeenCalled();
  });

  it("an uncommitted scrollback draft survives a section round-trip", async () => {
    await mount();
    toTerminal();
    type(scrollbackInput()!, "7");
    act(() => button("General").click());
    toTerminal();
    expect(scrollbackInput()!.value).toBe("7");
    // Still a draft — leaving the section is not a commit.
    expect(getSettings()?.scrollback).toBe(DEFAULT_SETTINGS.scrollback);
  });

  it("picking an agent writes the default through to the store", async () => {
    await mount({ defaultAgent: "codex" });
    act(() => button("Claude Code").click());
    expect(getSettings()?.defaultAgent).toBe("claude");
    // The active mark follows the store, not local state.
    expect(button("Claude Code").className).toContain("form__type--active");
  });

  it("marks the active choice", async () => {
    await mount({ defaultAgent: "codex" });
    expect(button("Codex").className).toContain("form__type--active");
    expect(button("Claude Code").className).not.toContain("form__type--active");
  });

  it("scrollback commits clamped on blur — not per keystroke", async () => {
    await mount();
    toTerminal();
    type(scrollbackInput()!, "7");
    expect(getSettings()?.scrollback).toBe(DEFAULT_SETTINGS.scrollback); // still typing
    blur(scrollbackInput()!);
    expect(getSettings()?.scrollback).toBe(SCROLLBACK_MIN);
    expect(scrollbackInput()!.value).toBe(String(SCROLLBACK_MIN));
  });

  it("a non-number reverts to the live value instead of writing", async () => {
    await mount();
    toTerminal();
    type(scrollbackInput()!, "lots");
    blur(scrollbackInput()!);
    expect(getSettings()?.scrollback).toBe(DEFAULT_SETTINGS.scrollback);
    expect(scrollbackInput()!.value).toBe(String(DEFAULT_SETTINGS.scrollback));
  });

  it("an unchanged commit writes nothing", async () => {
    await mount();
    toTerminal();
    blur(scrollbackInput()!);
    expect(ipc.saveSettings).not.toHaveBeenCalled();
  });

  it("Done, the ✕ and Escape only dismiss", async () => {
    await mount();
    act(() => button("Done").click());
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!
        .click(),
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(closed).toBe(3);
    expect(ipc.saveSettings).not.toHaveBeenCalled();
  });
});
