import { describe, expect, it } from "vitest";
import type { SpawnMcpInput } from "@keepdeck/plugin-api";
import { mcpArgs } from "./mcp";

const server = (name: string): SpawnMcpInput["servers"][number] => ({
  name,
  transport: "stdio",
  command: "/bin/keepdeck",
  args: ["--mcp-shim", "/home/mcp.sock"],
});

describe("claude --mcp-config", () => {
  it("declares EVERY server inline, keyed by name", () => {
    const args = mcpArgs({ servers: [server("keepdeck"), server("mnemo")] });
    expect(args[0]).toBe("--mcp-config");
    expect(JSON.parse(args[1]!)).toEqual({
      mcpServers: {
        keepdeck: {
          command: "/bin/keepdeck",
          args: ["--mcp-shim", "/home/mcp.sock"],
        },
        mnemo: {
          command: "/bin/keepdeck",
          args: ["--mcp-shim", "/home/mcp.sock"],
        },
      },
    });
  });

  it("never restricts the session to KeepDeck's servers", () => {
    // `--strict-mcp-config` would silence every server the user configured
    // themselves — injection ADDS, it does not take over.
    expect(mcpArgs({ servers: [server("keepdeck")] })).not.toContain(
      "--strict-mcp-config",
    );
  });

  it("carries env when a server declares it", () => {
    const args = mcpArgs({
      servers: [{ ...server("keepdeck"), env: { KD_PANE: "pane-3" } }],
    });
    expect(JSON.parse(args[1]!).mcpServers.keepdeck.env).toEqual({
      KD_PANE: "pane-3",
    });
  });

  it("adds nothing when there is nothing to inject", () => {
    expect(mcpArgs(undefined)).toEqual([]);
    expect(mcpArgs({ servers: [] })).toEqual([]);
  });
});
