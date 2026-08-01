// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginFailurePanel } from "./PluginFailurePanel";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const managerMock = vi.hoisted(() => ({
  restartPlugin: vi.fn(async () => {}),
}));
vi.mock("../../app/runtimeContext", () => ({
  useAppRuntime: () => ({ plugins: managerMock }),
}));
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
    root = createRoot(document.getElementById("host")!);
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
    Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === text,
    )!;

  it("names the plugin, the latest fallen surface, and shows the full log", () => {
    expect(document.body.textContent).toContain("Files isn't working");
    expect(document.body.textContent).toContain('tab "files"');
    const pre = document.querySelector(".plugin-failure__log")!;
    const log = pre.textContent!;
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
      document.querySelector(".plugin-failure__log")!.textContent,
    );
  });

  it("Restart plugin asks the manager to restart THIS plugin", () => {
    act(() => button("Restart plugin").click());
    expect(managerMock.restartPlugin).toHaveBeenCalledWith("keepdeck.files");
  });
});
