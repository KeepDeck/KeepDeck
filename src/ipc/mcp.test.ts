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
    invoke.mockResolvedValueOnce("/bin/keepdeck --mcp-shim");
    await expect(mcpConnectionCommand()).resolves.toBe("/bin/keepdeck --mcp-shim");
    expect(invoke).toHaveBeenCalledWith("mcp_connection_command");
  });
});
