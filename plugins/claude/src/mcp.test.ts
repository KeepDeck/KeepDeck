import { describe, expect, it } from "vitest";
import type { McpStdioServerSpec } from "@keepdeck/plugin-api";
import { mcpArgs } from "./mcp";

const server = (name: string): McpStdioServerSpec => ({
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

  it("keeps a passthrough name OUT of the config — claude inherits", () => {
    // The value is in the pane's environment already; naming the variable
    // in the config would add nothing, and an `env` entry would need a value
    // this renderer must never see.
    const args = mcpArgs({
      servers: [{ ...server("gh"), envPassthrough: ["GH_TOKEN"] }],
    });
    expect(JSON.parse(args[1]!).mcpServers.gh).toEqual({
      command: "/bin/keepdeck",
      args: ["--mcp-shim", "/home/mcp.sock"],
    });
  });

  it("declares a remote server as type http, token referenced as ${VAR}", () => {
    // claude expands `${VAR}` from its own environment — the pane's — so the
    // token never enters the argument `ps` can read.
    const args = mcpArgs({
      servers: [
        {
          name: "github",
          transport: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { "X-Org": "keepdeck" },
          bearerTokenEnv: "GH_TOKEN",
        },
      ],
    });
    expect(JSON.parse(args[1]!).mcpServers.github).toEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { "X-Org": "keepdeck", Authorization: "Bearer ${GH_TOKEN}" },
    });
  });

  it("leaves headers out of a remote server that sends none", () => {
    const args = mcpArgs({
      servers: [{ name: "plain", transport: "http", url: "https://mcp.example/" }],
    });
    expect(JSON.parse(args[1]!).mcpServers.plain).toEqual({
      type: "http",
      url: "https://mcp.example/",
    });
  });
});
