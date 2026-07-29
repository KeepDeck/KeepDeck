// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../domain/settings";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { GeneralSection } from "./GeneralSection";

const settings = vi.hoisted(() => ({ current: null as Settings | null }));
const settingsManager = vi.hoisted(() => ({ updateSettings: vi.fn() }));
vi.mock("../../app/settingsManager", () => ({
  getSettings: () => settings.current,
  subscribeSettings: () => () => {},
  updateSettings: settingsManager.updateSettings,
}));

// The agent catalog is a whole subsystem and none of it decides anything
// below; an empty one just renders no agent buttons.
vi.mock("../../app/useAgents", () => ({
  useAgents: () => ({ agents: [], loading: false }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("GeneralSection — dock mode", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    settingsManager.updateSettings.mockReset();
    settings.current = { ...DEFAULT_SETTINGS };
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = () => act(() => root.render(createElement(GeneralSection)));

  /** The Dock picker's buttons, by their visible labels. */
  const dockButtons = () =>
    new Map(
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).flatMap((b) =>
        b.textContent === "Docked" || b.textContent === "Floating"
          ? [[b.textContent, b] as const]
          : [],
      ),
    );

  const suspendedButtons = () =>
    new Map(
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).flatMap((b) =>
        b.textContent === "Keep pane" || b.textContent === "Tray"
          ? [[b.textContent, b] as const]
          : [],
      ),
    );

  it("marks the stored mode active and offers the other one", () => {
    // Both directions: an inverted comparison that happens to light the
    // non-default mode correctly would still leave the default one dead.
    mount();
    expect(dockButtons().get("Docked")?.className).toContain("form__type--active");
    expect(dockButtons().get("Floating")?.className).not.toContain(
      "form__type--active",
    );

    settings.current = { ...DEFAULT_SETTINGS, dockMode: "floating" };
    mount();
    expect(dockButtons().get("Floating")?.className).toContain("form__type--active");
    expect(dockButtons().get("Docked")?.className).not.toContain(
      "form__type--active",
    );
  });

  it("writes the picked mode through to settings", () => {
    mount();
    act(() => dockButtons().get("Floating")!.click());
    // Only the one key: the picker must not carry its neighbours along.
    expect(settingsManager.updateSettings).toHaveBeenCalledTimes(1);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      dockMode: "floating",
    });
  });

  it("explains what the CURRENT mode does, not a fixed sentence", () => {
    mount();
    const docked = Array.from(host.querySelectorAll(".settings__hint")).map(
      (h) => h.textContent,
    );
    settings.current = { ...DEFAULT_SETTINGS, dockMode: "floating" };
    mount();
    const floating = Array.from(host.querySelectorAll(".settings__hint")).map(
      (h) => h.textContent,
    );
    // The distinguishing phrase, not the sentence: what must hold is that the
    // hint follows the mode, and pinning the wording would make a typo fix
    // read as a regression. Sibling sections assert the same way.
    expect(docked.join(" ")).toContain("takes a column of its own");
    expect(floating.join(" ")).toContain("lies over the deck");
    expect(floating.join(" ")).not.toContain("takes a column of its own");
  });

  it("keeps suspended panes by default and writes the tray placement alone", () => {
    mount();
    expect(suspendedButtons().get("Keep pane")?.className).toContain(
      "form__type--active",
    );
    expect(suspendedButtons().get("Tray")?.className).not.toContain(
      "form__type--active",
    );

    act(() => suspendedButtons().get("Tray")!.click());
    expect(settingsManager.updateSettings).toHaveBeenCalledTimes(1);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      suspendedAgentPlacement: "tray",
    });
  });

  it("explains that restoring a suspended tray entry resumes it", () => {
    settings.current = {
      ...DEFAULT_SETTINGS,
      suspendedAgentPlacement: "tray",
    };
    mount();
    expect(
      Array.from(host.querySelectorAll(".settings__hint"))
        .map((hint) => hint.textContent)
        .join(" "),
    ).toContain("restoring one resumes it");
  });
});
