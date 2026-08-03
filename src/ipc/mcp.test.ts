import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { mcpConnectionCommand, mcpDisable, mcpEnable } from "./mcp";

/** Pins the wire contract: command names are what the Rust side registers —
 * a rename on either side must fail here, not at runtime. */
describe("mcp ipc", () => {
  beforeEach(() => invoke.mockReset());

  it("mcpEnable invokes mcp_enable and returns the socket path", async () => {
    invoke.mockResolvedValueOnce("/home/mcp.sock");
    await expect(mcpEnable()).resolves.toBe("/home/mcp.sock");
    expect(invoke).toHaveBeenCalledWith("mcp_enable");
  });

  it("mcpDisable invokes mcp_disable", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await mcpDisable();
    expect(invoke).toHaveBeenCalledWith("mcp_disable");
  });

  it("mcpConnectionCommand invokes mcp_connection_command", async () => {
    invoke.mockResolvedValueOnce({ command: "/bin/keepdeck", args: ["--mcp-shim"] });
    await expect(mcpConnectionCommand()).resolves.toEqual({
      command: "/bin/keepdeck",
      args: ["--mcp-shim"],
    });
    // No secret: the copy-pasteable command the settings page shows must
    // stay anonymous, so a hand-wired server is not attributed to a pane.
    expect(invoke).toHaveBeenCalledWith("mcp_connection_command", {
      client: undefined,
    });
  });

  it("mcpConnectionCommand can name the pane a spawn is for", async () => {
    invoke.mockResolvedValueOnce({ command: "/bin/keepdeck", args: [] });
    await mcpConnectionCommand("pane-3-secret");
    expect(invoke).toHaveBeenCalledWith("mcp_connection_command", {
      client: "pane-3-secret",
    });
  });
});
