// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginPage } from "./PluginPage";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const setEnabled = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../app/runtimeContext", () => ({
  useAppRuntime: () => ({
    plugins: {
      externalPluginInfo: () => null,
      pluginHost: { setEnabled },
      restartPlugin: async () => {},
    },
  }),
}));
vi.mock("../../app/useSettings", () => ({ useSettings: () => null }));

const FAILED_PLUGIN = {
  manifest: {
    id: "keepdeck.git",
    name: "Git",
    version: "1.4.0",
    minApiVersion: 1,
    category: "deck",
    capabilities: [],
    contributes: {},
  },
  status: { kind: "failed", reason: "spawn keepdeck-git ENOENT" },
} as never;

describe("PluginPage — the failure reason a user has to copy", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div>';
    root = createRoot(document.getElementById("host")!);
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
    expect(line!.textContent).toContain("keepdeck.git");
    expect(line!.textContent).toContain("1.4.0");
    expect(line!.textContent).toContain("spawn keepdeck-git ENOENT");
    // The document baseline makes chrome unselectable; diagnostic text has to
    // ask for the exception by name, or it cannot be copied into a bug report.
    expect(line!.classList.contains("kd-selectable")).toBe(true);
  });

  it("keeps that selectable text OUT of the enable toggle's label", () => {
    // Selecting text inside a <label> activates the label, and this one's
    // control is the plugin's enable checkbox — so a press-drag across the
    // error would have disabled the plugin the user was trying to report.
    // Any future selectable text placed in this page owes the same distance.
    const line = diagnostic();
    expect(line!.closest("label")).toBeNull();

    for (const selectable of document.querySelectorAll(".kd-selectable")) {
      expect(
        selectable.closest("label"),
        `selectable text sits inside a <label>: ${selectable.textContent}`,
      ).toBeNull();
    }
  });

  it("still toggles the plugin from the label that remains", () => {
    // The distance above must not have cost the toggle its own hit area.
    const label = document.querySelector<HTMLElement>(".settings__toggle")!;
    const name = label.querySelector<HTMLElement>(".settings__plugin-name")!;
    expect(name.closest("label")).toBe(label);

    const box = label.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => box.click());
    expect(setEnabled).toHaveBeenCalledTimes(1);
  });
});
