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
const mcpIpc = vi.hoisted(() => ({
  mcpConnectionCommand: vi.fn(() => Promise.resolve("/Applications/KeepDeck --mcp-shim")),
}));
vi.mock("../../ipc/mcp", () => mcpIpc);

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

  /** The On/Off pair under the row labelled `label`. Both rows carry the same
   * button captions, so selection must go through the row label. */
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
    act(() => rowButtons("MCP server").get("On")!.click());
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      mcpServer: true,
    });
    act(() => rowButtons("Remote agents").get("On")!.click());
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      remoteAgents: true,
    });
  });

  it("shows the connect command only while the server is on", async () => {
    mount();
    expect(host.querySelector("input.form__input")).toBeNull();
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mount();
    await act(() => Promise.resolve()); // the command fetch settles
    const input = host.querySelector<HTMLInputElement>("input.form__input");
    expect(input?.value).toBe("/Applications/KeepDeck --mcp-shim");
    expect(input?.readOnly).toBe(true);
  });

  it("marks the stored value active per row, not shared across rows", () => {
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mount();
    const mcp = rowButtons("MCP server");
    expect(mcp.get("On")!.className).toContain("form__type--active");
    expect(mcp.get("Off")!.className).not.toContain("form__type--active");
    expect(rowButtons("Remote agents").get("Off")!.className).toContain(
      "form__type--active",
    );
  });
});
