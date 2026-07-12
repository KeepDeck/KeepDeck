// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsSectionContribution } from "@keepdeck/plugin-api";
import {
  getSettings,
  initSettings,
  resetSettingsManager,
} from "../../app/settingsManager";
import { PluginSettingsSection } from "./PluginSettingsSection";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The section writes through the real settings manager over a mocked IPC —
// the tests cover the whole loop: control → store → re-render.
const ipc = vi.hoisted(() => ({
  loadSettings: vi.fn<() => Promise<string | null>>(async () => null),
  saveSettings: vi.fn<(json: string) => Promise<void>>(async () => {}),
  quarantineSettings: vi.fn<() => Promise<void>>(async () => {}),
}));
vi.mock("../../ipc/settings", () => ipc);

// The picker-mode add flow reads the installed-apps scan — mocked here.
const appIpc = vi.hoisted(() => ({
  listApplications: vi.fn<() => Promise<string[]>>(async () => []),
}));
vi.mock("../../ipc/app", () => appIpc);

const section: SettingsSectionContribution = {
  label: "Run",
  fields: [
    {
      kind: "stringList",
      key: "openApps",
      label: "Open in applications",
      default: ["Visual Studio Code"],
      placeholder: "Application name",
    },
  ],
};

describe("PluginSettingsSection — the stringList editor", () => {
  let host: HTMLElement;
  let root: Root;

  const storedApps = () =>
    getSettings()?.plugins.values["keepdeck.run"]?.openApps;
  const entries = () =>
    [...document.querySelectorAll(".settings__list-entry")].map(
      (n) => n.textContent,
    );
  const addInput = () =>
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Add Open in applications"]',
    )!;
  const addButton = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Add",
    )!;

  const type = (text: string) => {
    const el = addInput();
    const set = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el),
      "value",
    )!.set!;
    act(() => {
      set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const mount = async () => {
    await initSettings();
    await act(async () => {
      root.render(
        createElement(PluginSettingsSection, {
          pluginId: "keepdeck.run",
          section,
        }),
      );
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetSettingsManager();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    resetSettingsManager();
  });

  it("shows the field default when nothing is stored", async () => {
    await mount();
    expect(entries()).toEqual(["Visual Studio Code"]);
  });

  it("adds a trimmed entry and stores the grown list", async () => {
    await mount();
    type("  IntelliJ IDEA  ");
    act(() => addButton().click());
    expect(entries()).toEqual(["Visual Studio Code", "IntelliJ IDEA"]);
    expect(storedApps()).toEqual(["Visual Studio Code", "IntelliJ IDEA"]);
    // The input clears for the next entry.
    expect(addInput().value).toBe("");
  });

  it("Enter in the input adds too; blanks and duplicates never enter", async () => {
    await mount();
    const enter = () =>
      act(() => {
        addInput().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
    type("   ");
    enter();
    expect(entries()).toEqual(["Visual Studio Code"]);
    type("Visual Studio Code");
    enter();
    expect(entries()).toEqual(["Visual Studio Code"]);
    // The duplicate draft still clears — it already sits in the list.
    expect(addInput().value).toBe("");
  });

  it("removes an entry and stores the shrunk list — down to empty", async () => {
    await mount();
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Remove Visual Studio Code"]',
        )!
        .click(),
    );
    expect(entries()).toEqual([]);
    // An explicitly emptied list is stored as [], NOT reset to the default.
    expect(storedApps()).toEqual([]);
  });
});

describe("PluginSettingsSection — the application-picker add flow", () => {
  const pickerSection: SettingsSectionContribution = {
    label: "Run",
    fields: [
      {
        kind: "stringList",
        key: "openApps",
        label: "Open in applications",
        default: ["Visual Studio Code"],
        picker: "application",
      },
    ],
  };

  let host: HTMLElement;
  let root: Root;

  const entries = () =>
    [...document.querySelectorAll(".settings__list-entry")].map(
      (n) => n.textContent,
    );
  const mount = async () => {
    await initSettings();
    await act(async () => {
      root.render(
        createElement(PluginSettingsSection, {
          pluginId: "keepdeck.run",
          section: pickerSection,
        }),
      );
    });
    // Flush the installed-apps scan into the combobox options.
    await act(async () => {});
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetSettingsManager();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    resetSettingsManager();
  });

  const combo = () =>
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Add Open in applications"]',
    )!;
  const menuOptions = () =>
    [...document.querySelectorAll(".dropdown__option")].map(
      (n) => n.textContent,
    );

  it("offers the installed apps minus what's already listed", async () => {
    appIpc.listApplications.mockResolvedValue([
      "Android Studio",
      "IntelliJ IDEA",
      "Visual Studio Code",
    ]);
    await mount();
    act(() => combo().focus());
    // "Visual Studio Code" already sits in the list — the menu skips it.
    expect(menuOptions()).toEqual(["Android Studio", "IntelliJ IDEA"]);
  });

  it("picking an app from the menu adds it and clears the field", async () => {
    appIpc.listApplications.mockResolvedValue(["Android Studio"]);
    await mount();
    act(() => combo().focus());
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>(".dropdown__option")]
        .find((b) => b.textContent === "Android Studio")!
        .click(),
    );
    expect(entries()).toEqual(["Visual Studio Code", "Android Studio"]);
    expect(
      getSettings()?.plugins.values["keepdeck.run"]?.openApps,
    ).toEqual(["Visual Studio Code", "Android Studio"]);
    expect(combo().value).toBe("");
  });

  it("the combobox is the whole add flow — no other buttons in the row", async () => {
    await mount();
    expect(
      [...document.querySelectorAll(".settings__list-add button")].map(
        (b) => b.getAttribute("aria-label") ?? b.textContent,
      ),
    ).toEqual(["Toggle Add Open in applications options"]);
  });
});
