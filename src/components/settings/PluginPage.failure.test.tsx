// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "../../plugins";
import { PluginPage } from "./PluginPage";
import { present } from "@keepdeck/plugin-api/testing";

const setEnabled = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../app/runtimeContext", async () =>
  (await import("../../app/runtimeContext.test-support")).runtimePartsModule({
    plugins: {
      externalPluginInfo: () => null,
      pluginHost: { setEnabled },
      restartPlugin: async () => {},
    },
  }));
vi.mock("../../app/useSettings", () => ({ useSettings: () => null, useSettingsWrite: () => () => {} }));

const FAILED_PLUGIN: InstalledPlugin = {
  manifest: {
    id: "keepdeck.git",
    name: "Git",
    version: "1.4.0",
    minApiVersion: 1,
    category: "deck",
    capabilities: [],
    contributes: {},
  },
  source: "builtin",
  status: { kind: "failed", reason: "spawn keepdeck-git ENOENT" },
};

describe("PluginPage — the failure reason a user has to copy", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div>';
    root = createRoot(present(document.getElementById("host"), "element \"host\""));
    setEnabled.mockClear();
    act(() =>
      root.render(
        createElement(PluginPage, {
          plugin: FAILED_PLUGIN,
          section: null,
          featureCatalog: [],
        }),
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const diagnostic = () =>
    [...document.querySelectorAll<HTMLElement>(".settings__hint")].find((el) =>
      el.textContent?.includes("failed:"),
    );

  it("spells out why the plugin broke, and lets that text be selected", () => {
    const line = diagnostic();
    expect(line, "no line carries the failure reason").toBeDefined();
    expect(present(line, "line").textContent).toContain("keepdeck.git");
    expect(present(line, "line").textContent).toContain("1.4.0");
    expect(present(line, "line").textContent).toContain("spawn keepdeck-git ENOENT");
    // The document baseline makes chrome unselectable; diagnostic text has to
    // ask for the exception by name, or it cannot be copied into a bug report.
    expect(present(line, "line").classList.contains("kd-selectable")).toBe(true);
  });

  it("keeps that selectable text OUT of the enable toggle's label", () => {
    // Selecting text inside a <label> activates the label, and this one's
    // control is the plugin's enable checkbox — so a press-drag across the
    // error would have disabled the plugin the user was trying to report.
    // Any future selectable text placed in this page owes the same distance.
    const line = diagnostic();
    expect(present(line, "line").closest("label")).toBeNull();

    for (const selectable of document.querySelectorAll(".kd-selectable")) {
      expect(
        selectable.closest("label"),
        `selectable text sits inside a <label>: ${selectable.textContent}`,
      ).toBeNull();
    }
  });

  it("still toggles the plugin from the label that remains", () => {
    // The distance above must not have cost the toggle its own hit area.
    const label = present(document.querySelector<HTMLElement>(".settings__toggle"), "element \".settings__toggle\"");
    const name = present(label.querySelector<HTMLElement>(".settings__plugin-name"), "element \".settings__plugin-name\"");
    expect(name.closest("label")).toBe(label);

    const box = present(label.querySelector<HTMLInputElement>('input[type="checkbox"]'), "element 'input[type=\"checkbox\"]'");
    act(() => box.click());
    expect(setEnabled).toHaveBeenCalledTimes(1);
  });
});
