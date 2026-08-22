import { describe, expect, it } from "vitest";
import type { McpServerSpec } from "@keepdeck/plugin-api";
import { kimiMcpConfig, mcpFileRenderer } from "./kimi";

const server = (name: string): McpServerSpec => ({
  name,
  transport: "stdio",
  command: "/bin/keepdeck",
  args: ["--mcp-shim", "/home/mcp.sock"],
});

describe("which agents are fed by file", () => {
  it("answers with a renderer for the file-fed agent and null for argv ones", () => {
    // The injection flow asks this instead of naming an agent: everything it
    // does differently for a file — one secret per shared cwd, nothing on
    // argv — follows from the delivery, not from which CLI it belongs to.
    expect(mcpFileRenderer("kimi")).not.toBeNull();
    for (const argvFed of ["claude", "codex", "opencode", "grok"]) {
      expect(mcpFileRenderer(argvFed)).toBeNull();
    }
  });

  it("hands back the dialect's own renderer, not a copy of its shape", () => {
    expect(mcpFileRenderer("kimi")).toBe(kimiMcpConfig);
  });
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
