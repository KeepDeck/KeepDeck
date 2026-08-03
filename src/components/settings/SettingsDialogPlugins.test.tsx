// @vitest-environment happy-dom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  button,
  dialogHost,
  mountDialog,
  panelOf,
  pluginRegistries,
  pluginStore,
  resetSettingsManager,
  type Settings,
} from "./testSupport";

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

const CLI_PLUGIN = {
  manifest: {
    id: "example.cli",
    name: "Example CLI",
    version: "1.0.0",
    minApiVersion: 30,
    category: "cli",
    capabilities: [],
    contributes: {
      agents: [
        {
          id: "example-agent",
          label: "Example Agent",
          bin: "example",
          features: [
            {
              id: "session.new",
              label: "New sessions",
              group: "sessions",
            },
            {
              id: "session.resume",
              label: "Resume saved sessions",
              group: "sessions",
            },
            {
              id: "usage.pane",
              label: "Session analytics",
              group: "usage",
            },
            {
              id: "usage.account",
              label: "Account limits",
              group: "usage",
            },
            {
              id: "target.remote",
              label: "Remote targets",
              group: "execution",
              parameters: { schemes: ["ws", "wss"] },
            },
            {
              id: "vendor.future",
              label: "A future plugin feature",
              group: "custom",
            },
          ],
        },
      ],
    },
  },
  status: { kind: "active" },
};

const YOLO_ONLY_PLUGIN = {
  ...CLI_PLUGIN,
  manifest: {
    ...CLI_PLUGIN.manifest,
    id: "yolo.cli",
    name: "YOLO CLI",
    contributes: {
      agents: [
        {
          id: "yolo-agent",
          label: "YOLO Agent",
          bin: "yolo",
          features: [
            {
              id: "execution.yolo",
              label: "YOLO mode",
              group: "execution",
            },
          ],
        },
      ],
    },
  },
};

describe("SettingsDialog — plugin sections", () => {
  let root: Root;
  let closed: number;

  beforeEach(() => {
    root = dialogHost();
    closed = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    resetSettingsManager();
  });

  const mount = (
    overrides: Partial<Settings> = {},
    initialSectionId?: string,
  ) => mountDialog(root, () => closed++, overrides, initialSectionId);


  it("an installed plugin is its own nav section: toggle plus contributed fields", async () => {
    const registries = await pluginRegistries();
    pluginStore.set([FILES_PLUGIN]);
    const section = registries.settingsSections.add("keepdeck.files", {
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
      // The section owns scrolling inside the bounded settings body; the only
      // dismiss control lives in the fixed header, outside that scroll area.
      const body = document.querySelector(".settings__body")!;
      expect(body.contains(panelOf(feature))).toBe(true);
      expect(
        body.contains(
          document.querySelector('[aria-label="Close settings"]')!,
        ),
      ).toBe(false);
    } finally {
      section.dispose();
    }
  });

  it("renders arbitrary features directly from active plugin manifests", async () => {
    pluginStore.set([CLI_PLUGIN, YOLO_ONLY_PLUGIN]);
    await mount();
    act(() => button("Example CLI").click());

    const features = document.querySelector(
      '[aria-label="Example CLI features"]',
    )!;
    expect(panelOf(features).hasAttribute("hidden")).toBe(false);
    expect(features.textContent).toContain("CLI features");
    expect(features.textContent).not.toContain("Example Agent");
    expect(features.textContent).not.toContain("example-agent");
    expect(features.textContent).toContain("Resume saved sessions");
    expect(features.textContent).toContain("Session analytics");
    expect(features.textContent).toContain("Account limits");
    expect(features.textContent).toContain("A future plugin feature");
    expect(features.textContent).toContain(
      "Remote targetsSupported · schemes: ws, wss",
    );
    const states = Array.from(
      features.querySelectorAll(".settings__feature-state"),
      (state) => state.textContent,
    );
    const firstUnsupported = states.findIndex((state) =>
      state?.startsWith("Not supported"),
    );
    expect(firstUnsupported).toBeGreaterThan(0);
    expect(
      states
        .slice(firstUnsupported)
        .every((state) => state?.startsWith("Not supported")),
    ).toBe(true);
  });

  it("names agents only when one plugin contributes more than one", async () => {
    pluginStore.set([
      {
        ...CLI_PLUGIN,
        manifest: {
          ...CLI_PLUGIN.manifest,
          contributes: {
            agents: [
              ...CLI_PLUGIN.manifest.contributes.agents,
              {
                id: "second-agent",
                label: "Second Agent",
                bin: "second",
                features: [
                  {
                    id: "session.new",
                    label: "New sessions",
                    group: "sessions",
                  },
                ],
              },
            ],
          },
        },
      },
    ]);
    await mount();
    act(() => button("Example CLI").click());

    const features = document.querySelector(
      '[aria-label="Example CLI features"]',
    )!;
    expect(features.textContent).toContain("Example Agent");
    expect(features.textContent).toContain("Second Agent");
  });

  it("reads the same feature declaration while a CLI plugin is disabled", async () => {
    pluginStore.set([
      {
        ...CLI_PLUGIN,
        status: { kind: "disabled" },
      },
    ]);
    await mount();
    act(() => button("Example CLI").click());

    const features = document.querySelector(
      '[aria-label="Example CLI features"]',
    )!;
    expect(features.textContent).not.toContain(
      "the plugin is disabled",
    );
    expect(features.textContent).toContain("Resume saved sessionsSupported");
    expect(features.textContent).toContain("A future plugin featureSupported");
  });

  it("reveals a plugin opened directly below the navigation fold", async () => {
    const plugins = Array.from({ length: 12 }, (_, index) => ({
      ...FILES_PLUGIN,
      manifest: {
        ...FILES_PLUGIN.manifest,
        id: `example.plugin-${index}`,
        name: `Plugin ${index}`,
      },
    }));
    pluginStore.set(plugins);
    let revealed: Element | null = null;
    const reveal = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        revealed = this;
      });
    try {
      await mount({}, "plugin:example.plugin-11");
      expect(button("Plugin 11").getAttribute("aria-current")).toBe("true");
      expect(revealed).toBe(button("Plugin 11"));
    } finally {
      reveal.mockRestore();
    }
  });

  it("re-reveals the active plugin after a rescan changes nav order", async () => {
    const deckPlugin = {
      ...FILES_PLUGIN,
      manifest: {
        ...FILES_PLUGIN.manifest,
        id: "example.deck",
        name: "Deck Plugin",
      },
    };
    const cliPlugin = {
      ...FILES_PLUGIN,
      manifest: {
        ...FILES_PLUGIN.manifest,
        id: "example.cli",
        name: "CLI Plugin",
        category: "cli" as const,
      },
    };
    pluginStore.set([deckPlugin]);
    const revealed: Element[] = [];
    const reveal = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        revealed.push(this);
      });
    try {
      await mount({}, "plugin:example.deck");
      revealed.length = 0;

      // The host snapshot preserves install order, but Settings puts CLI
      // plugins first. A rescan can therefore move the same active deck row.
      act(() => pluginStore.set([deckPlugin, cliPlugin]));

      expect(revealed).toEqual([button("Deck Plugin")]);
    } finally {
      reveal.mockRestore();
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
