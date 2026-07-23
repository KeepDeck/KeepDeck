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
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
// A controllable installed-plugins store: tests install/uninstall plugins and
// the dialog reacts through the same useSyncExternalStore path as the real
// host (stable snapshots, notified subscribers).
const pluginStore = vi.hoisted(() => {
  let installed: unknown[] = [];
  const subscribers = new Set<() => void>();
  return {
    getInstalled: () => installed,
    subscribe: (cb: () => void) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    set(next: unknown[]) {
      installed = next;
      for (const cb of [...subscribers]) cb();
    },
  };
});
const runtimeMock = vi.hoisted(() => ({ registries: null as any }));

vi.mock("../../app/runtimeContext", async () => {
  const { createContributionRegistries } = await import(
    "../../plugins/registries/contributions"
  );
  const registries = createContributionRegistries();
  runtimeMock.registries = registries;
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
    useAppRuntime: () => ({
      plugins: {
        pluginRegistries: registries,
        bootstrapPlugins: () => Promise.resolve(),
        // Per-plugin sections render in the dialog's nav tree — the controllable
        // store keeps it honest without pulling the real Tauri-backed manager in.
        pluginHost: {
          getInstalled: pluginStore.getInstalled,
          subscribe: pluginStore.subscribe,
          setEnabled: async () => {},
        },
        externalPluginInfo: () => null,
        rescanPlugins: async () => {},
        restartPlugin: async () => {},
      },
    }),
    AppRuntimeProvider: ({ children }: { children: unknown }) => children,
  };
});

/** An installed, active Files plugin — enough manifest for a PluginPage. */
const FILES_PLUGIN = {
  manifest: {
    id: "keepdeck.files",
    name: "Files",
    version: "0.1.0",
    minApiVersion: 1,
    category: "deck",
    capabilities: [],
    contributes: { settings: true },
  },
  status: { kind: "active" },
};

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
    pluginStore.set([]);
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
      root.render(createElement(SettingsDialog, { onClose: () => closed++ })),
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
    expect(button("Terminal").className).toContain(
      "settings__nav-item--active",
    );
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

  it("keeps observational usage statistics out of settings", async () => {
    await mount();
    const labels = [...document.querySelectorAll(".settings__nav-item")].map(
      (entry) => entry.textContent,
    );
    expect(labels).not.toContain("Stats");
    expect(button("24h")).toBeUndefined();
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

  it("picking a deck layout writes it through to the store", async () => {
    await mount({ deckLayout: "grid" });
    act(() => button("List").click());
    expect(getSettings()?.deckLayout).toBe("list");
    expect(button("List").className).toContain("form__type--active");
  });

  it("switching the YOLO default writes it through to the store", async () => {
    await mount();
    // Scoped to its own picker group — other sections have On/Off pairs too.
    const label = Array.from(document.querySelectorAll(".form__label")).find(
      (el) => el.textContent === "YOLO mode",
    )!;
    const on = Array.from(label.nextElementSibling!.querySelectorAll("button")).find(
      (b) => b.textContent === "On",
    )!;
    act(() => on.click());
    expect(getSettings()?.defaultYolo).toBe(true);
    expect(on.className).toContain("form__type--active");
  });

  it("picking a minimize style writes it through to the store", async () => {
    await mount({ minimizeStyle: "tray" });
    act(() => button("Strip").click());
    expect(getSettings()?.minimizeStyle).toBe("strip");
    // The active mark follows the store, not local state.
    expect(button("Strip").className).toContain("form__type--active");
  });

  it("marks the active minimize style", async () => {
    await mount({ minimizeStyle: "strip" });
    expect(button("Strip").className).toContain("form__type--active");
    expect(button("Tray").className).not.toContain("form__type--active");
  });

  it("turns minimizing off with None", async () => {
    await mount({ minimizeStyle: "tray" });
    act(() => button("None").click());
    expect(getSettings()?.minimizeStyle).toBe("none");
    expect(button("None").className).toContain("form__type--active");
  });

  it("disables the minimize-style picker outside the grid layout", async () => {
    await mount({ deckLayout: "list" });
    expect((button("Tray") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Strip") as HTMLButtonElement).disabled).toBe(true);
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

  it("an installed plugin is its own nav section: toggle plus contributed fields", async () => {
    const pluginRegistries = runtimeMock.registries;
    pluginStore.set([FILES_PLUGIN]);
    const section = pluginRegistries.settingsSections.add("keepdeck.files", {
      label: "Files",
      fields: [
        {
          kind: "boolean",
          key: "openFileLinks",
          label: "Open terminal file links in KeepDeck",
          default: true,
        },
      ],
    });
    try {
      await mount();
      act(() => button("Files").click());
      const enable = document.querySelector<HTMLInputElement>(
        'input[aria-label="Enable plugin Files"]',
      )!;
      const feature = document.querySelector<HTMLInputElement>(
        'input[aria-label="Open terminal file links in KeepDeck"]',
      )!;
      // Everything about the plugin lives on ITS page.
      expect(panelOf(enable).hasAttribute("hidden")).toBe(false);
      expect(panelOf(feature).hasAttribute("hidden")).toBe(false);
      expect(feature.checked).toBe(true); // the schema default, no stored value
      // The section owns scrolling inside the bounded settings body; the
      // footer remains its sibling so long plugin pages can never paint over
      // the Done action again.
      const body = document.querySelector(".settings__body")!;
      expect(body.contains(panelOf(feature))).toBe(true);
      expect(body.contains(button("Done"))).toBe(false);
    } finally {
      section.dispose();
    }
  });

  it("visually separates a plugin description from its notification control", async () => {
    pluginStore.set([
      {
        ...FILES_PLUGIN,
        manifest: {
          ...FILES_PLUGIN.manifest,
          description: "A description that may wrap across multiple lines.",
          capabilities: [{ kind: "notifications" }],
        },
      },
    ]);
    await mount();
    act(() => button("Files").click());

    const about = document.querySelector(".settings__plugin-about")!;
    const notifications = document.querySelector(
      ".settings__plugin-notifications",
    )!;
    expect(about.nextElementSibling).toBe(notifications);
    expect(notifications.classList).toContain("settings__plugin-row");
  });

  it("falls back to the first section when the open plugin section vanishes", async () => {
    pluginStore.set([FILES_PLUGIN]);
    await mount();
    act(() => button("Files").click());
    expect(button("Files").className).toContain("settings__nav-item--active");

    // A rescan/uninstall removes the plugin while its page is open.
    act(() => pluginStore.set([]));
    expect(button("General").className).toContain("settings__nav-item--active");
    expect(panelOf(button("Claude Code")).hasAttribute("hidden")).toBe(false);
  });
});
