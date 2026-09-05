// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

/**
 * What the two SettingsDialog suites share: the mocked host the dialog is
 * rendered against, and the DOM helpers its controls are driven with.
 *
 * The mocks live HERE rather than twice over. Splitting the plugin-section
 * cases into their own file copied a hundred lines of doubles with them, and
 * two copies of a host is two hosts to keep true — the MCP status double had
 * already gone stale in one of them. Everything the suites need is
 * re-exported, and they import nothing else from the module graph: a direct
 * import of a mocked module would load the real one before these register.
 */

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The dialog's sections talk to the real settings manager over a mocked IPC —
// the tests cover the whole loop: control → store → re-render.
const settingsIpc = vi.hoisted(() => ({
  loadSettings: vi.fn<() => Promise<string | null>>(async () => null),
  saveSettings: vi.fn<(json: string) => Promise<void>>(async () => {}),
  quarantineSettings: vi.fn<() => Promise<void>>(async () => {}),
  snapshotSettings: vi.fn<() => Promise<void>>(async () => {}),
}));
vi.mock("../../ipc/settings", () => settingsIpc);

// The General section's artifacts and MCP rows read the MCP transport's
// confirmed status from the app runtime; the dialog tests run without a
// runtime provider, so the hook is answered directly — socket not
// confirmed, nothing to connect to.
vi.mock("../../app/mcp/useMcpStatus", () => ({
  useMcpStatus: () => ({
    socket: null,
    error: null,
    connect: null,
    connectError: null,
    refused: [],
  }),
}));

// The General section assembles the agent catalog from the plugin registry
// (seeded with the three built-in cli agents) plus per-mount detection —
// detectBins is the refetch tripwire.
const agents = vi.hoisted(() => ({
  detectBins: vi.fn(async (bins: string[]) =>
    bins.map((bin) => ({ bin, installed: true, path: null })),
  ),
}));
vi.mock("../../ipc/agents", () => agents);

// A controllable installed-plugins store: tests install/uninstall plugins and
// the dialog reacts through the same useSyncExternalStore path as the real
// host (stable snapshots, notified subscribers).
const plugins = vi.hoisted(() => {
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

const runtime = vi.hoisted(() => ({
  registries: null as unknown as ReturnType<
    typeof import("../../plugins/registries/contributions").createContributionRegistries
  >,
}));

vi.mock("../../app/runtimeContext", async () => {
  const { createContributionRegistries } = await import(
    "../../plugins/registries/contributions"
  );
  const registries = createContributionRegistries();
  runtime.registries = registries;
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
          getInstalled: plugins.getInstalled,
          subscribe: plugins.subscribe,
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

import {
  initSettings,
  resetSettingsManager,
  updateSettings,
} from "../../app/settingsManager";
import type { Settings } from "../../domain/settings";

export { getSettings, resetSettingsManager, updateSettings } from "../../app/settingsManager";
export { DEFAULT_SETTINGS, SCROLLBACK_MIN } from "../../domain/settings";
export type { Settings } from "../../domain/settings";

// Re-exported through bindings of their own: a hoisted declaration cannot be
// an export itself, and the suites assert on these.
export const ipc = settingsIpc;
export const agentsIpc = agents;
export const pluginStore = plugins;

/** The contribution registries the mocked runtime hands the dialog — where a
 * test adds the section a plugin contributes.
 *
 * Async because the mock factory only runs when the runtime module is first
 * imported, and nothing has imported it until the dialog mounts; awaiting the
 * import here is what makes the registries exist before a test seeds them. */
export async function pluginRegistries() {
  await import("../../app/runtimeContext");
  return runtime.registries;
}

export const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  )!;

export const scrollbackInput = () =>
  document.querySelector<HTMLInputElement>(
    'input[aria-label="Terminal scrollback lines"]',
  );

/** The section panel an element lives in — visibility is per panel (`hidden`),
 * inactive sections stay mounted. */
export const panelOf = (el: Element) => el.closest(".settings__section")!;

/** Type into a controlled React input: set via the native setter (bypassing
 * React's value tracker) and fire a bubbling `input` event. */
export function type(el: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export const blur = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

/** A clean host for one test: the doubles' call history dropped, the settings
 * store and plugin list emptied, and a fresh React root to render into. */
export function dialogHost(): Root {
  settingsIpc.saveSettings.mockClear();
  agents.detectBins.mockClear();
  resetSettingsManager();
  plugins.set([]);
  document.body.innerHTML = "<div id='host'></div>";
  return createRoot(document.getElementById("host")!);
}

/** Render the dialog with `overrides` already stored — the seeding writes are
 * not under test, so the queued save is let land and then dropped.
 *
 * The dialog is imported HERE, not at the top: a static import would pull it —
 * and the runtime context it reads — into this module's own evaluation, which
 * runs before the `vi.mock` registrations above and would hand it the real
 * one. */
export async function mountDialog(
  root: Root,
  onClose: () => void,
  overrides: Partial<Settings> = {},
  initialSectionId?: string,
): Promise<void> {
  const { SettingsDialog } = await import("./SettingsDialog");
  await initSettings();
  if (Object.keys(overrides).length > 0) updateSettings(overrides);
  await new Promise((resolve) => setTimeout(resolve, 0));
  settingsIpc.saveSettings.mockClear();
  await act(async () =>
    root.render(createElement(SettingsDialog, { onClose, initialSectionId })),
  );
  await act(async () => {}); // flush the agent-catalog load
}
