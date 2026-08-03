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
// The connect invocation arrives WITH the status: it is a fact about the
// running transport, so this component neither fetches it nor holds it.
const invocation = {
  command: "/Applications/KeepDeck",
  args: ["--mcp-shim", "/Users/u/.config/keepdeck/mcp/mcp.sock"],
};
const mcpStatus = vi.hoisted(() => ({
  current: {
    socket: null as string | null,
    error: null as string | null,
    connect: null as { command: string; args: string[] } | null,
    connectError: null as string | null,
    refused: [] as { root: string; reason: string }[],
  },
}));
vi.mock("../../app/mcp/useMcpStatus", () => ({
  useMcpStatus: () => mcpStatus.current,
}));
const clipboard = vi.hoisted(() => ({
  writeText: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../ipc/clipboard", () => clipboard);

/** A confirmed-up transport, with whatever else the case is about. */
const up = (extra: Partial<typeof mcpStatus.current> = {}) => ({
  socket: "/home/mcp.sock",
  error: null,
  connect: invocation,
  connectError: null,
  refused: [],
  ...extra,
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("ExperimentalSection", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    settingsManager.updateSettings.mockReset();
    clipboard.writeText.mockClear();
    settings.current = { ...DEFAULT_SETTINGS };
    mcpStatus.current = {
      socket: null,
      error: null,
      connect: null,
      connectError: null,
      refused: [],
    };
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

  /** The connect command as rendered — read-only text, not a field. */
  const connectLine = () =>
    host.querySelector<HTMLElement>(".settings__command");

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
    // advertising a command here would point at someone else's deck — even if
    // a line from the last confirmed socket is still on the status.
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mcpStatus.current = { ...up(), socket: null };
    mount();
    await settle();
    expect(connectLine()).toBeNull();

    mcpStatus.current = up();
    mount();
    await settle();
    const line = connectLine();
    expect(line?.textContent).toBe(
      "/Applications/KeepDeck --mcp-shim /Users/u/.config/keepdeck/mcp/mcp.sock",
    );
    // Not a field: a caret and a typing attempt are exactly what the old
    // read-only <input> invited.
    expect(host.querySelector("input.form__input")).toBeNull();
  });

  it("the row leaves with the served status (live Off)", async () => {
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mcpStatus.current = up();
    mount();
    await settle();
    expect(connectLine()).not.toBeNull();
    mcpStatus.current = { ...up(), socket: null, connect: null };
    mount();
    await settle();
    expect(connectLine()).toBeNull();
  });

  it("a failed enable surfaces as a message, not a silently missing row", async () => {
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mcpStatus.current = {
      ...up(),
      socket: null,
      connect: null,
      error: "already served by another process",
    };
    mount();
    await settle();
    expect(host.textContent).toContain("reported a problem");
    expect(host.textContent).toContain("already served by another process");
  });

  it("a failed disable is visible even though the setting is already Off", async () => {
    // The one report that says "the socket may still be serving" arrives
    // exactly when the toggle reads Off — a setting-gated row would eat it.
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: false };
    mcpStatus.current = up({ error: "ipc failure" });
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
    mcpStatus.current = up({ error: "ipc failure" });
    mount();
    await settle();
    expect(connectLine()).not.toBeNull();
    expect(host.textContent).toContain("reported a problem");
    expect(host.textContent).toContain("no longer reachable");
  });

  it("says the server is up while the lookup is still out — never nothing at all", async () => {
    // The one publishable combination with no row and no message. It is
    // transient by design, but silence is the failure mode here: the user sees
    // the toggle On and no sign the deck agrees.
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mcpStatus.current = up({ connect: null, connectError: null });
    mount();
    await settle();

    expect(connectLine()).toBeNull();
    expect(host.textContent).toContain("New agent panes connect to it");
  });

  it("drops the Copied confirmation when the command changes under it", async () => {
    // The confirmation may never stand over a line the user has not copied —
    // a re-enable on a different socket produces exactly that.
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mcpStatus.current = up();
    mount();
    await settle();
    const copy = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy",
    );
    act(() => copy!.click());
    await settle();
    expect(host.textContent).toContain("Copied");

    mcpStatus.current = up({
      connect: { ...invocation, args: ["--mcp-shim", "/home/other.sock"] },
    });
    mount();
    await settle();

    expect(host.textContent).not.toContain("Copied");
    expect(connectLine()?.textContent).toContain("/home/other.sock");
  });

  it("keeps it through a status change the row does not show", async () => {
    // The reset keys on the rendered command, not on the status object: a
    // refusal appearing elsewhere must not wipe the confirmation.
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mcpStatus.current = up();
    mount();
    await settle();
    const copy = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy",
    );
    act(() => copy!.click());
    await settle();

    mcpStatus.current = up({
      refused: [{ root: "/repo/api", reason: "theirs" }],
    });
    mount();
    await settle();

    expect(host.textContent).toContain("Copied");
  });

  it("a failed command lookup says so — the server IS serving", async () => {
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mcpStatus.current = up({
      connect: null,
      connectError: "path contains a symlink",
    });
    mount();
    await settle();
    expect(connectLine()).toBeNull();
    expect(host.textContent).toContain("connect command could not be determined");
    expect(host.textContent).toContain("path contains a symlink");
  });

  it("promises injection only while the socket is CONFIRMED up", async () => {
    // The promise is only true when there IS a server: a pane is given it at
    // spawn, so saying so with the transport down would be a lie.
    mount();
    await settle();
    expect(host.textContent).not.toContain("New agent panes connect to it");

    mcpStatus.current = up();
    mount();
    await settle();
    expect(host.textContent).toContain("New agent panes connect to it");
  });

  it("names each refused folder AND why, since the fix differs per reason", async () => {
    // The fix is the user's to make and it is not the same fix: move your own
    // config aside, or the folder is gone, or it could not be written. A
    // single asserted reason sent people looking for a file that is not there.
    mcpStatus.current = up({
      refused: [
        { root: "/repo/api", reason: ".kimi-code/mcp.json here is not KeepDeck's" },
        { root: "/wt/gone", reason: "this directory no longer exists" },
      ],
    });
    mount();
    await settle();

    expect(host.textContent).toContain("/repo/api");
    expect(host.textContent).toContain("is not KeepDeck's");
    expect(host.textContent).toContain("/wt/gone");
    expect(host.textContent).toContain("no longer exists");
  });

  it("copies the command to the clipboard, and says it did", async () => {
    // The whole point of the row: the user takes this line elsewhere. Copying
    // must not depend on selecting monospace text with a mouse.
    settings.current = { ...DEFAULT_SETTINGS, mcpServer: true };
    mcpStatus.current = up();
    mount();
    await settle();

    const copy = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy",
    );
    act(() => copy!.click());
    await settle();

    expect(clipboard.writeText).toHaveBeenCalledWith(
      "/Applications/KeepDeck --mcp-shim /Users/u/.config/keepdeck/mcp/mcp.sock",
    );
    expect(host.textContent).toContain("Copied");
  });
});
