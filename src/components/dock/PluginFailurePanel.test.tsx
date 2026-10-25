// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginFailurePanel } from "./PluginFailurePanel";
import { present } from "@keepdeck/plugin-api/testing";

const managerMock = vi.hoisted(() => ({
  restartPlugin: vi.fn(async () => {}),
}));
vi.mock("../../app/runtimeContext", async () =>
  (await import("../../app/runtimeContext.test-support")).runtimePartsModule({ plugins: managerMock }));
const clipboardMock = vi.hoisted(() => ({
  writeText: vi.fn(async (_text: string) => {}),
}));
vi.mock("../../ipc/clipboard", () => clipboardMock);

const CRASHES = [
  {
    pluginId: "keepdeck.files",
    surfaceKind: "overlay" as const,
    surfaceId: "viewer",
    detail: "Error: render died\n  at FilesOverlay",
  },
  {
    pluginId: "keepdeck.files",
    surfaceKind: "tab" as const,
    surfaceId: "files",
    detail: "Error: again",
  },
];

describe("PluginFailurePanel", () => {
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the #host element"));
    act(() =>
      root.render(
        createElement(PluginFailurePanel, {
          pluginId: "keepdeck.files",
          label: "Files",
          crashes: CRASHES,
        }),
      ),
    );
  });
  afterEach(() => act(() => root.unmount()));

  const button = (text: string) =>
    present(Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === text,
    ), "the button elements");

  it("names the plugin, the latest fallen surface, and shows the full log", () => {
    expect(document.body.textContent).toContain("Files isn't working");
    expect(document.body.textContent).toContain('tab "files"');
    const pre = present(document.querySelector(".plugin-failure__log"), "the .plugin-failure__log element");
    const log = present(pre.textContent, "the failure log text");
    expect(log).toContain('[overlay "viewer"] Error: render died');
    expect(log).toContain('[tab "files"] Error: again');
    // Copy log is one way out; selecting part of it is the other, and the
    // document baseline withholds that unless the log asks for it by name.
    expect(pre.classList.contains("kd-selectable")).toBe(true);
  });

  it("Copy log puts the exact log text on the clipboard", () => {
    act(() => button("Copy log").click());
    expect(clipboardMock.writeText).toHaveBeenCalledTimes(1);
    const copied = clipboardMock.writeText.mock.calls[0][0];
    expect(copied).toBe(
      present(document.querySelector(".plugin-failure__log"), "the .plugin-failure__log element").textContent,
    );
  });

  it("Restart plugin asks the manager to restart THIS plugin", () => {
    act(() => button("Restart plugin").click());
    expect(managerMock.restartPlugin).toHaveBeenCalledWith("keepdeck.files");
  });
});
