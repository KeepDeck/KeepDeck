import { describe, expect, it } from "vitest";
import type { McpStdioServerSpec } from "@keepdeck/plugin-api";
import { mcpConfigFragment } from "./mcp";

const server = (name: string): McpStdioServerSpec => ({
  name,
  transport: "stdio",
  command: "/bin/keepdeck",
  args: ["--mcp-shim", "/home/mcp.sock"],
});

describe("the opencode mcp config fragment", () => {
  it("names each server in opencode's own local shape", () => {
    // `command` is program + arguments in ONE array here — opencode's shape,
    // not the {command, args} pair every other CLI takes.
    expect(mcpConfigFragment({ servers: [server("keepdeck")] })).toEqual({
      mcp: {
        keepdeck: {
          type: "local",
          command: ["/bin/keepdeck", "--mcp-shim", "/home/mcp.sock"],
          enabled: true,
        },
      },
    });
  });

  it("carries every server, not just the first", () => {
    const fragment = mcpConfigFragment({
      servers: [server("keepdeck"), server("mnemo")],
    });
    expect(Object.keys(fragment!.mcp)).toEqual(["keepdeck", "mnemo"]);
  });

  it("has no fragment at all when there is nothing to inject", () => {
    expect(mcpConfigFragment(undefined)).toBeNull();
    expect(mcpConfigFragment({ servers: [] })).toBeNull();
  });

  it("keeps a passthrough name out of the fragment — opencode inherits", () => {
    const fragment = mcpConfigFragment({
      servers: [{ ...server("gh"), envPassthrough: ["GH_TOKEN"] }],
    });
    expect(fragment!.mcp.gh).toEqual({
      type: "local",
      command: ["/bin/keepdeck", "--mcp-shim", "/home/mcp.sock"],
      enabled: true,
    });
  });

  it("declares a remote server in opencode's remote shape, token as {env:VAR}", () => {
    // `{env:NAME}` is opencode's own substitution for a value read from its
    // environment — the pane's — so the token never enters the config.
    const fragment = mcpConfigFragment({
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
    expect(fragment!.mcp.github).toEqual({
      type: "remote",
      url: "https://api.githubcopilot.com/mcp/",
      enabled: true,
      headers: { "X-Org": "keepdeck", Authorization: "Bearer {env:GH_TOKEN}" },
    });
  });

  it("leaves headers out of a remote server that sends none", () => {
    // opencode's config schema is strict; an empty map is a key it did not
    // ask for.
    const fragment = mcpConfigFragment({
      servers: [{ name: "plain", transport: "http", url: "https://mcp.example/" }],
    });
    expect(fragment!.mcp.plain).toEqual({
      type: "remote",
      url: "https://mcp.example/",
      enabled: true,
    });
  });
});
