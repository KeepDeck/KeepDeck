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
