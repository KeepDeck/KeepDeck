import { describe, expect, it } from "vitest";
import type { McpServerSpec } from "@keepdeck/plugin-api";
import { kimiMcpConfig } from "./kimi";

const server = (name: string): McpServerSpec => ({
  name,
  transport: "stdio",
  command: "/bin/keepdeck",
  args: ["--mcp-shim", "/home/mcp.sock"],
});

describe("kimi's mcp.json", () => {
  it("keys every server by name in the shape kimi's loader reads", () => {
    // The file IS the delivery for kimi — it takes nothing on argv — so the
    // shape is the whole contract.
    const written = JSON.parse(
      kimiMcpConfig([server("keepdeck"), server("mnemo")]),
    );
    expect(written).toEqual({
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

  it("carries env only when a server declares it", () => {
    const withEnv = JSON.parse(
      kimiMcpConfig([{ ...server("keepdeck"), env: { KD_PANE: "pane-3" } }]),
    );
    expect(withEnv.mcpServers.keepdeck.env).toEqual({ KD_PANE: "pane-3" });
    const without = JSON.parse(kimiMcpConfig([server("keepdeck")]));
    expect("env" in without.mcpServers.keepdeck).toBe(false);
  });

  it("writes a file, not a fragment — parseable and newline-terminated", () => {
    const text = kimiMcpConfig([server("keepdeck")]);
    expect(text.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("has an empty server map when there is nothing to declare", () => {
    // Not "no file": the arming path only reaches here with an accepted set,
    // and an empty map is still valid config kimi reads as no servers.
    expect(JSON.parse(kimiMcpConfig([]))).toEqual({ mcpServers: {} });
  });
});
