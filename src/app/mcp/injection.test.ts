import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpInjection, KEEPDECK_MCP_SERVER } from "./injection";
import type { McpConnection } from "../../ipc/mcp";

const invocation: McpConnection = {
  command: "/Applications/KeepDeck.app/Contents/MacOS/keepdeck",
  args: ["--mcp-shim", "/home/.config/keepdeck/mcp/mcp.sock"],
};

let socket: string | null;

beforeEach(() => {
  socket = "/home/.config/keepdeck/mcp/mcp.sock";
});

describe("the MCP injection", () => {
  it("renders the backend's invocation verbatim — it never rebuilds one", () => {
    // The shim flag and the socket path have one home, on the Rust side. A
    // second derivation here would drift the day either changes.
    const connection = vi.fn(async () => invocation);
    const injection = createMcpInjection({ socket: () => socket, connection });

    return injection.defs().then((defs) => {
      expect(defs).toEqual([
        {
          name: KEEPDECK_MCP_SERVER,
          transport: "stdio",
          command: invocation.command,
          args: invocation.args,
        },
      ]);
    });
  });

  it("injects NOTHING while the transport is not confirmed up", async () => {
    // The gate is the confirmed socket, not the setting: a pane handed a def
    // for a socket that is down spends its startup failing to connect and
    // shows a broken server instead of no server.
    socket = null;
    const connection = vi.fn(async () => invocation);
    const injection = createMcpInjection({ socket: () => socket, connection });

    expect(await injection.defs()).toEqual([]);
    // And it does not even ask the backend how to connect.
    expect(connection).not.toHaveBeenCalled();
  });

  it("injects nothing when the toggle goes Off while the backend answers", async () => {
    // The await is a window: a def minted after the socket went away would be
    // handed to a pane whose server no longer exists.
    let release!: (c: McpConnection) => void;
    const connection = vi.fn(
      () => new Promise<McpConnection>((resolve) => (release = resolve)),
    );
    const injection = createMcpInjection({ socket: () => socket, connection });

    const pending = injection.defs();
    socket = null;
    release(invocation);

    expect(await pending).toEqual([]);
  });

  it("asks the backend ONCE — the invocation is a fact about the install", async () => {
    const connection = vi.fn(async () => invocation);
    const injection = createMcpInjection({ socket: () => socket, connection });

    await Promise.all([injection.defs(), injection.defs()]);
    await injection.defs();

    expect(connection).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failure — the next pane may still get served", async () => {
    // Refusing forever because one call failed would need an app restart to
    // recover, for a transport that is otherwise perfectly up.
    const connection = vi
      .fn<() => Promise<McpConnection>>()
      .mockRejectedValueOnce(new Error("no home directory"))
      .mockResolvedValue(invocation);
    const injection = createMcpInjection({ socket: () => socket, connection });

    expect(await injection.defs()).toEqual([]);
    expect((await injection.defs()).map((d) => d.name)).toEqual([
      KEEPDECK_MCP_SERVER,
    ]);
  });
});
