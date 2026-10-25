// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../domain/settings";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { ArtifactsRows } from "./ArtifactsRows";
import { present } from "@keepdeck/plugin-api/testing";

const settings = vi.hoisted(() => ({ current: null as Settings | null }));
const settingsManager = vi.hoisted(() => ({ updateSettings: vi.fn() }));
vi.mock("../../app/settingsManager", () => ({
  getSettings: () => settings.current,
  subscribeSettings: () => () => {},
  updateSettings: settingsManager.updateSettings,
}));
// Only the confirmed socket matters here; the rest of the status belongs
// to the MCP row beneath these.
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

describe("ArtifactsRows", () => {
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

  const mount = () => act(() => root.render(createElement(ArtifactsRows)));

  const labels = () =>
    Array.from(host.querySelectorAll(".form__label")).map((el) => el.textContent);

  /** The On/Off pair under the row labelled `label`. Both rows carry the
   * same button captions, so selection must go through the row label. */
  const rowButtons = (label: string) => {
    const row = Array.from(host.querySelectorAll<HTMLElement>(".form__label")).find(
      (el) => el.textContent === label,
    );
    if (!row?.nextElementSibling) throw new Error(`no row "${label}"`);
    const buttons = new Map<string, HTMLButtonElement>();
    for (const b of row.nextElementSibling.querySelectorAll("button")) {
      buttons.set(b.textContent ?? "", b);
    }
    return buttons;
  };

  it("each toggle writes its own settings key", () => {
    settings.current = { ...DEFAULT_SETTINGS, artifacts: true };
    mount();
    act(() => present(rowButtons("Fleet artifacts").get("Off"), "entry \"Off\" in rowButtons(\"Fleet artifacts\")").click());
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      artifacts: false,
    });
    act(() => present(rowButtons("Auto-open artifacts").get("Off"), "entry \"Off\" in rowButtons(\"Auto-open artifacts\")").click());
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      artifactAutoOpen: false,
    });
  });

  it("marks the stored value active per row, not shared across rows", () => {
    settings.current = { ...DEFAULT_SETTINGS, artifacts: true, artifactAutoOpen: false };
    mount();
    expect(present(rowButtons("Fleet artifacts").get("On"), "entry \"On\" in rowButtons(\"Fleet artifacts\")").className).toContain(
      "form__type--active",
    );
    expect(present(rowButtons("Auto-open artifacts").get("Off"), "entry \"Off\" in rowButtons(\"Auto-open artifacts\")").className).toContain(
      "form__type--active",
    );
    expect(present(rowButtons("Auto-open artifacts").get("On"), "entry \"On\" in rowButtons(\"Auto-open artifacts\")").className).not.toContain(
      "form__type--active",
    );
  });

  it("offers auto-open only while artifacts are on — it is inert otherwise", () => {
    mount();
    expect(labels()).toEqual(["Fleet artifacts"]);
    settings.current = { ...DEFAULT_SETTINGS, artifacts: true };
    mount();
    expect(labels()).toEqual(["Fleet artifacts", "Auto-open artifacts"]);
  });

  it("does not call the feature an experiment", () => {
    mount();
    expect(host.textContent).not.toContain("experimental");
  });

  it("says the socket is down only while it is, and only while artifacts are on", () => {
    // The hint and the tool-registration gate key on the same confirmed
    // status, so they agree on what "down" means.
    settings.current = { ...DEFAULT_SETTINGS, artifacts: true };
    mount();
    expect(host.textContent).toContain("MCP socket is down");
    expect(host.textContent).toContain("cannot publish");

    mcpStatus.socket = "/home/mcp.sock";
    mount();
    expect(host.textContent).not.toContain("MCP socket is down");

    mcpStatus.socket = null;
    settings.current = { ...DEFAULT_SETTINGS, artifacts: false };
    mount();
    expect(host.textContent).not.toContain("cannot publish");
  });
});
