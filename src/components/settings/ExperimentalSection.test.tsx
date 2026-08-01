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
const mcpStatus = vi.hoisted(() => ({
  current: { socket: null as string | null, error: null as string | null },
}));
vi.mock("../../app/mcp/useMcpStatus", () => ({
  useMcpStatus: () => mcpStatus.current,
}));
const mcpIpc = vi.hoisted(() => ({
  mcpConnectionCommand: vi.fn(() =>
    Promise.resolve({
      command: "/Applications/KeepDeck",
      args: ["--mcp-shim", "/Users/u/.config/keepdeck/mcp/mcp.sock"],
    }),
  ),
}));
vi.mock("../../ipc/mcp", () => mcpIpc);

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("ExperimentalSection", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    settingsManager.updateSettings.mockReset();
    mcpIpc.mcpConnectionCommand.mockClear();
    settings.current = { ...DEFAULT_SETTINGS };
    mcpStatus.current = { socket: null, error: null };
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = () => act(() => root.render(createElement(ExperimentalSection)));
  const settle = () => act(() => Promise.resolve());

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

  const connectInput = () =>
    host.querySelector<HTMLInputElement>("input.form__input");

  it("each toggle writes its own settings key", async () => {
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

  it("the connect row keys on the CONFIRMED status, not the setting", async () => {
    // Setting on, transport not confirmed (refused enable, other instance):
    // advertising a command here would point at someone else's deck.
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mount();
    await settle();
    expect(connectInput()).toBeNull();
    expect(mcpIpc.mcpConnectionCommand).not.toHaveBeenCalled();

    mcpStatus.current = { socket: "/home/mcp.sock", error: null };
    mount();
    await settle();
    const input = connectInput();
    expect(input?.value).toBe(
      "/Applications/KeepDeck --mcp-shim /Users/u/.config/keepdeck/mcp/mcp.sock",
    );
    expect(input?.readOnly).toBe(true);
  });

  it("the row leaves with the served status (live Off)", async () => {
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mcpStatus.current = { socket: "/home/mcp.sock", error: null };
    mount();
    await settle();
    expect(connectInput()).not.toBeNull();
    mcpStatus.current = { socket: null, error: null };
    mount();
    await settle();
    expect(connectInput()).toBeNull();
  });

  it("a failed enable surfaces as a message, not a silently missing row", async () => {
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mcpStatus.current = { socket: null, error: "already served by another process" };
    mount();
    await settle();
    expect(host.textContent).toContain("reported a problem");
    expect(host.textContent).toContain("already served by another process");
  });

  it("a failed disable is visible even though the setting is already Off", async () => {
    // The one report that says "the socket may still be serving" arrives
    // exactly when the toggle reads Off — a setting-gated row would eat it.
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: false };
    mcpStatus.current = { socket: "/home/mcp.sock", error: "ipc failure" };
    mount();
    await settle();
    expect(host.textContent).toContain("reported a problem");
    expect(host.textContent).toContain("ipc failure");
  });

  it("a kept socket claim and a problem render together, and the hint says so", async () => {
    // After a failed disable the socket is (probably) still up: the
    // connect row stays truthful, but must not read as an unqualified
    // invitation while the transport is reporting a problem.
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: false };
    mcpStatus.current = { socket: "/home/mcp.sock", error: "ipc failure" };
    mount();
    await settle();
    expect(connectInput()).not.toBeNull();
    expect(host.textContent).toContain("reported a problem");
    expect(host.textContent).toContain("no longer reachable");
  });

  it("a failed command fetch says so — the server IS serving", async () => {
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mcpStatus.current = { socket: "/home/mcp.sock", error: null };
    mcpIpc.mcpConnectionCommand.mockRejectedValueOnce(
      new Error("path contains a symlink"),
    );
    mount();
    await settle();
    expect(connectInput()).toBeNull();
    expect(host.textContent).toContain("connect command could not be determined");
    expect(host.textContent).toContain("path contains a symlink");
  });
});
