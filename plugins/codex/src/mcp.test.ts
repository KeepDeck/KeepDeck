import { describe, expect, it } from "vitest";
import type { SpawnMcpInput } from "@keepdeck/plugin-api";
import { mcpArgs } from "./mcp";

const input = (...servers: SpawnMcpInput["servers"]): SpawnMcpInput => ({
  servers,
});

const server = (name: string): SpawnMcpInput["servers"][number] => ({
  name,
  transport: "stdio",
  command: "/bin/keepdeck",
  args: ["--mcp-shim", "/home/mcp.sock"],
});

describe("codex MCP overrides", () => {
  it("emits one -c override per server, not one for the first", () => {
    // The bank contributes more members than the built-in transport; a
    // renderer that emitted a single entry would drop the rest silently.
    expect(mcpArgs(input(server("keepdeck"), server("mnemo")))).toEqual([
      "-c",
      'mcp_servers.keepdeck={command="/bin/keepdeck",args=["--mcp-shim","/home/mcp.sock"]}',
      "-c",
      'mcp_servers.mnemo={command="/bin/keepdeck",args=["--mcp-shim","/home/mcp.sock"]}',
    ]);
  });

  it("escapes what TOML cannot carry raw", () => {
    // The value is parsed as TOML: an unescaped quote or backslash makes the
    // override a literal string, or refused outright. App bundles on Windows
    // and paths with quotes are the realistic sources.
    const quoted = {
      ...server("keepdeck"),
      command: 'C:\\Program Files\\Keep"Deck\\keepdeck.exe',
      args: ["--mcp-shim", "/tmp/a\tb"],
    };
    expect(mcpArgs(input(quoted))[1]).toBe(
      'mcp_servers.keepdeck={command="C:\\\\Program Files\\\\Keep\\"Deck\\\\keepdeck.exe",' +
        'args=["--mcp-shim","/tmp/a\\tb"]}',
    );
  });

  it("declares env explicitly — codex does not pass its own to MCP children", () => {
    // Probe-verified on 0.146: the child gets a core allowlist only, so a
    // value left to inheritance reaches three CLIs and not this one.
    const withEnv = { ...server("keepdeck"), env: { KD_PANE: "pane-3" } };
    expect(mcpArgs(input(withEnv))[1]).toContain('env={"KD_PANE"="pane-3"}');
  });

  it("adds nothing when there is nothing to inject", () => {
    expect(mcpArgs(undefined)).toEqual([]);
    expect(mcpArgs(input())).toEqual([]);
  });
});
