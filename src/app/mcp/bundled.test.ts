import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConnection } from "../../ipc/mcp";
import {
  KEEPDECK_MCP_SERVER,
  keepdeckServer,
  type McpContributionTarget,
} from "./bundled";

const invocation: McpConnection = {
  command: "/Applications/KeepDeck.app/Contents/MacOS/keepdeck",
  args: ["--mcp-shim", "/home/.config/keepdeck/mcp/mcp.sock"],
};

const target: McpContributionTarget = {
  agentType: "claude",
  cwd: "/repo",
  workspaceId: "ws-1",
  client: "pane-secret",
};

let socket: string | null;

beforeEach(() => {
  socket = "/home/.config/keepdeck/mcp/mcp.sock";
});

describe("KeepDeck's own server as a bundled contributor", () => {
  it("renders the backend's invocation verbatim — it never rebuilds one", async () => {
    // The shim flag and the socket path have one home, on the Rust side. A
    // second derivation here would drift the day either changes.
    const server = keepdeckServer({ socket: () => socket, connection: async () => invocation });

    expect(await server.contribute(target)).toEqual({
      name: KEEPDECK_MCP_SERVER,
      transport: "stdio",
      command: invocation.command,
      args: invocation.args,
    });
    expect(server.name).toBe(KEEPDECK_MCP_SERVER);
  });

  it("contributes NOTHING while the transport is not confirmed up", async () => {
    // The gate is the confirmed socket: a pane handed a def for a socket that
    // is down spends its startup failing to connect and shows a broken server
    // instead of no server.
    socket = null;
    const connection = vi.fn(async () => invocation);
    const server = keepdeckServer({ socket: () => socket, connection });

    expect(await server.contribute(target)).toBeNull();
    // And it does not even ask the backend how to connect.
    expect(connection).not.toHaveBeenCalled();
  });

  it("asks for an invocation that NAMES the pane it was asked for", async () => {
    // The secret is what lets a call be attributed to the pane that made it,
    // and it is the backend that spells the shim's flags — asking without it
    // would hand every pane the same anonymous command.
    const connection = vi.fn(async () => invocation);
    const server = keepdeckServer({ socket: () => socket, connection });

    await server.contribute({ ...target, client: "pane-3-secret" });

    expect(connection).toHaveBeenCalledWith("pane-3-secret");
  });

  it("asks for an ANONYMOUS invocation when the pane cannot carry a secret", async () => {
    const connection = vi.fn(async () => invocation);
    const server = keepdeckServer({ socket: () => socket, connection });

    await server.contribute({ ...target, client: null });

    expect(connection).toHaveBeenCalledWith(undefined);
  });

  it("does not remember a failure — the next pane may still get served", async () => {
    // Refusing forever because one call failed would need an app restart to
    // recover, for a transport that is otherwise perfectly up.
    const connection = vi
      .fn<() => Promise<McpConnection>>()
      .mockRejectedValueOnce(new Error("no home directory"))
      .mockResolvedValue(invocation);
    const server = keepdeckServer({ socket: () => socket, connection });

    expect(await server.contribute(target)).toBeNull();
    expect((await server.contribute(target))?.name).toBe(KEEPDECK_MCP_SERVER);
  });
});
