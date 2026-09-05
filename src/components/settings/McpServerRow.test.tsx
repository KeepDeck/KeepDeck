// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServerRow } from "./McpServerRow";

// The connect invocation arrives WITH the status: it is a fact about the
// running transport, so this component neither fetches it nor holds it.
const invocation = {
  command: "/Applications/KeepDeck",
  args: ["--mcp-shim", "/Users/u/.config/keepdeck/mcp/mcp.sock"],
};
type Status = {
  socket: string | null;
  error: string | null;
  connect: { command: string; args: string[] } | null;
  connectError: string | null;
  refused: { root: string; reason: string }[];
};
const mcpStatus = vi.hoisted(() => ({
  current: {
    socket: null,
    error: null,
    connect: null,
    connectError: null,
    refused: [],
  } as Status,
}));
vi.mock("../../app/mcp/useMcpStatus", () => ({
  useMcpStatus: () => mcpStatus.current,
}));
const clipboard = vi.hoisted(() => ({
  writeText: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../ipc/clipboard", () => clipboard);

/** Before the enable settles: nothing confirmed, nothing wrong. */
const down = (): Status => ({
  socket: null,
  error: null,
  connect: null,
  connectError: null,
  refused: [],
});

/** A confirmed-up transport, with whatever else the case is about. */
const up = (extra: Partial<Status> = {}): Status => ({
  socket: "/home/mcp.sock",
  error: null,
  connect: invocation,
  connectError: null,
  refused: [],
  ...extra,
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("McpServerRow", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    clipboard.writeText.mockClear();
    mcpStatus.current = down();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = () => act(() => root.render(createElement(McpServerRow)));
  const settle = () => act(() => Promise.resolve());

  /** The connect command as rendered — read-only text, not a field. */
  const connectLine = () =>
    host.querySelector<HTMLElement>(".settings__command");

  const copyButton = () =>
    Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy",
    );

  it("renders the command as read-only text, never as a field", async () => {
    mcpStatus.current = up();
    mount();
    await settle();
    expect(connectLine()?.textContent).toBe(
      "/Applications/KeepDeck --mcp-shim /Users/u/.config/keepdeck/mcp/mcp.sock",
    );
    // Not a field: a caret and a typing attempt are exactly what the old
    // read-only <input> invited.
    expect(host.querySelector("input.form__input")).toBeNull();
    expect(copyButton()).toBeDefined();
  });

  it("shows no command before the socket is confirmed, and says so", async () => {
    // Silence is the failure mode: with no switch to read, "no row" would
    // mean "no server" to the user.
    mount();
    await settle();
    expect(connectLine()).toBeNull();
    expect(copyButton()).toBeUndefined();
    expect(host.textContent).toContain("coming up");
  });

  it("the row keys on the CONFIRMED socket, not on a leftover line", async () => {
    // A line can only be minted for a confirmed socket, so this shape is
    // defensive — but a row that outlived its socket would point a client at
    // nothing.
    mcpStatus.current = { ...up(), socket: null };
    mount();
    await settle();
    expect(connectLine()).toBeNull();
  });

  it("a refused enable surfaces as a message where the command would be", async () => {
    mcpStatus.current = {
      ...down(),
      error: "already served by another process",
    };
    mount();
    await settle();
    expect(connectLine()).toBeNull();
    expect(host.textContent).toContain("reported a problem");
    expect(host.textContent).toContain("already served by another process");
    expect(host.textContent).not.toContain("coming up");
  });

  it("a problem is said even beside a command", async () => {
    // Whatever else is on screen, the one line explaining that the command
    // shown may not work must not be eaten by the command's presence.
    mcpStatus.current = up({ error: "ipc failure" });
    mount();
    await settle();
    expect(connectLine()).not.toBeNull();
    expect(host.textContent).toContain("reported a problem");
    expect(host.textContent).toContain("ipc failure");
  });

  it("says the server is up while the lookup is still out — never nothing at all", async () => {
    mcpStatus.current = up({ connect: null, connectError: null });
    mount();
    await settle();
    expect(connectLine()).toBeNull();
    expect(host.textContent).toContain("looking up");
  });

  it("a failed command lookup says so — the server IS serving", async () => {
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

  it("copies the command to the clipboard, and says it did", async () => {
    // The whole point of the row: the user takes this line elsewhere. Copying
    // must not depend on selecting monospace text with a mouse.
    mcpStatus.current = up();
    mount();
    await settle();

    act(() => copyButton()!.click());
    await settle();

    expect(clipboard.writeText).toHaveBeenCalledWith(
      "/Applications/KeepDeck --mcp-shim /Users/u/.config/keepdeck/mcp/mcp.sock",
    );
    expect(host.textContent).toContain("Copied");
  });

  it("drops the Copied confirmation when the command changes under it", async () => {
    // The confirmation may never stand over a line the user has not copied —
    // a retry landing on a different socket produces exactly that.
    mcpStatus.current = up();
    mount();
    await settle();
    act(() => copyButton()!.click());
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

  it("keeps the confirmation through a status change the row does not show", async () => {
    // The reset keys on the rendered command, not on the status object: a
    // refusal appearing elsewhere must not wipe the confirmation.
    mcpStatus.current = up();
    mount();
    await settle();
    act(() => copyButton()!.click());
    await settle();

    mcpStatus.current = up({
      refused: [{ root: "/repo/api", reason: "theirs" }],
    });
    mount();
    await settle();

    expect(host.textContent).toContain("Copied");
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
});
