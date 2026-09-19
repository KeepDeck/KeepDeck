// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../domain/settings";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { TasksRows } from "./TasksRows";

const settings = vi.hoisted(() => ({ current: null as Settings | null }));
const settingsManager = vi.hoisted(() => ({ updateSettings: vi.fn() }));
vi.mock("../../app/settingsManager", () => ({
  getSettings: () => settings.current,
  subscribeSettings: () => () => {},
  updateSettings: settingsManager.updateSettings,
}));
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

describe("TasksRows", () => {
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

  const mount = () => act(() => root.render(createElement(TasksRows)));
  const buttons = () =>
    new Map(
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).map((b) => [
        b.textContent ?? "",
        b,
      ]),
    );

  it("writes the tasks key and marks the stored value active", () => {
    mount();
    expect(buttons().get("Off")!.className).toContain("form__type--active");
    act(() => buttons().get("On")!.click());
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({ tasks: true });
    settings.current = { ...DEFAULT_SETTINGS, tasks: true };
    mount();
    expect(buttons().get("On")!.className).toContain("form__type--active");
  });

  it("promises no delivery: the hint says agents learn of a task from mail", () => {
    mount();
    expect(host.textContent).toContain("from a teammate’s mail, never from the board");
    expect(host.textContent).not.toContain("experimental");
  });

  it("says the socket is down only while it is, and only while tasks are on", () => {
    settings.current = { ...DEFAULT_SETTINGS, tasks: true };
    mount();
    expect(host.textContent).toContain("MCP socket is down");
    mcpStatus.socket = "/home/mcp.sock";
    mount();
    expect(host.textContent).not.toContain("MCP socket is down");
    mcpStatus.socket = null;
    settings.current = { ...DEFAULT_SETTINGS, tasks: false };
    mount();
    expect(host.textContent).not.toContain("MCP socket is down");
  });
});
