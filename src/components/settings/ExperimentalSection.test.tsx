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
// Only the confirmed socket matters to this section; the rest of the
// status belongs to the MCP row in General.
const mcpStatus = vi.hoisted(() => ({ socket: null as string | null }));
vi.mock("../../app/mcp/useMcpStatus", () => ({
  useMcpStatus: () => ({
    socket: mcpStatus.socket,
    error: null,
    connect: null,
    connectError: null,
    refused: [],
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("ExperimentalSection", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    settingsManager.updateSettings.mockReset();
    settings.current = { ...DEFAULT_SETTINGS };
    mcpStatus.socket = null;
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = () => act(() => root.render(createElement(ExperimentalSection)));

  /** The On/Off pair under the row labelled `label`. Every row carries the
   * same button captions, so selection must go through the row label. */
  const rowButtons = (label: string) => {
    const labels = Array.from(host.querySelectorAll<HTMLElement>(".form__label"));
    const row = labels.find((el) => el.textContent === label);
    if (!row?.nextElementSibling) throw new Error(`no row "${label}"`);
    const buttons = new Map<string, HTMLButtonElement>();
    for (const b of row.nextElementSibling.querySelectorAll("button")) {
      buttons.set(b.textContent ?? "", b);
    }
    return buttons;
  };

  it("each toggle writes its own settings key", () => {
    mount();
    act(() => rowButtons("Remote agents").get("On")!.click());
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      remoteAgents: true,
    });
    act(() => rowButtons("Agent teams").get("On")!.click());
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      agentTeams: true,
    });
    act(() => rowButtons("Fleet artifacts").get("On")!.click());
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      artifacts: true,
    });
  });

  it("marks the stored value active per row, not shared across rows", () => {
    settings.current = { ...DEFAULT_SETTINGS, agentTeams: true };
    mount();
    const teams = rowButtons("Agent teams");
    expect(teams.get("On")!.className).toContain("form__type--active");
    expect(teams.get("Off")!.className).not.toContain("form__type--active");
    expect(rowButtons("Remote agents").get("Off")!.className).toContain(
      "form__type--active",
    );
  });

  it("carries no MCP switch — the socket is not an experiment", () => {
    mount();
    const labels = Array.from(host.querySelectorAll(".form__label")).map(
      (label) => label.textContent,
    );
    expect(labels).not.toContain("MCP server");
    expect(host.querySelector(".settings__command")).toBeNull();
  });

  // The two features that ride the socket say so only while it is actually
  // down, and only while they are on: the hint and the tool-registration
  // gate key on the same confirmed status, so they agree on what "down"
  // means.
  for (const [key, phrase] of [
    ["agentTeams", "never reply"],
    ["artifacts", "cannot publish"],
  ] as const) {
    it(`${key}: says the socket is down only while it is, and only while on`, () => {
      settings.current = { ...DEFAULT_SETTINGS, [key]: true };
      mount();
      expect(host.textContent).toContain("MCP socket is down");
      expect(host.textContent).toContain(phrase);

      mcpStatus.socket = "/home/mcp.sock";
      mount();
      expect(host.textContent).not.toContain("MCP socket is down");

      mcpStatus.socket = null;
      settings.current = { ...DEFAULT_SETTINGS, [key]: false };
      mount();
      expect(host.textContent).not.toContain(phrase);
    });
  }
});
