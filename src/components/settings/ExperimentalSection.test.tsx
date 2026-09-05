// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../domain/settings";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { ExperimentalSection } from "./ExperimentalSection";

const settings = vi.hoisted(() => ({ current: null as Settings | null }));
const settingsManager = vi.hoisted(() => ({ updateSettings: vi.fn() }));
vi.mock("../../app/settingsManager", () => ({
  getSettings: () => settings.current,
  subscribeSettings: () => () => {},
  updateSettings: settingsManager.updateSettings,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("ExperimentalSection", () => {
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

  const mount = () => act(() => root.render(createElement(ExperimentalSection)));

  const buttons = () =>
    new Map(
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).map(
        (b) => [b.textContent ?? "", b] as const,
      ),
    );

  it("writes the remote-agents key, and marks the stored value active", () => {
    mount();
    expect(buttons().get("Off")!.className).toContain("form__type--active");
    act(() => buttons().get("On")!.click());
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      remoteAgents: true,
    });

    settings.current = { ...DEFAULT_SETTINGS, remoteAgents: true };
    mount();
    expect(buttons().get("On")!.className).toContain("form__type--active");
    expect(buttons().get("Off")!.className).not.toContain("form__type--active");
  });

  it("lists only what is still an experiment", () => {
    // The MCP socket, agent teams and fleet artifacts graduated: none of
    // them has a row here.
    mount();
    const labels = Array.from(host.querySelectorAll(".form__label")).map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(["Remote agents"]);
  });
});
