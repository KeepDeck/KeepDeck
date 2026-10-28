import { describe, expect, it } from "vitest";
import type { McpServerSpec, McpStdioServerSpec } from "@keepdeck/plugin-api";
import { KIMI_MCP_PATH, kimiMcpArms, kimiMcpConfig } from "./mcp";

const server = (name: string): McpStdioServerSpec => ({
  name,
  transport: "stdio",
  command: "/bin/keepdeck",
  args: ["--mcp-shim", "/home/mcp.sock"],
});

/** The golden bytes: what the host wrote for a pane before the renderer moved
 * here, byte for byte — the pane's own secret on the shim, and a remote server
 * whose token stays in the environment. */
const GOLDEN_PANE =
  "{\n" +
  '  "mcpServers": {\n' +
  '    "keepdeck": {\n' +
  '      "command": "/bin/keepdeck",\n' +
  '      "args": [\n' +
  '        "--mcp-shim",\n' +
  '        "/home/mcp.sock",\n' +
  '        "--client",\n' +
  '        "kd-mcp-pane-secret"\n' +
  "      ]\n" +
  "    },\n" +
  '    "github": {\n' +
  '      "transport": "http",\n' +
  '      "url": "https://api.githubcopilot.com/mcp/",\n' +
  '      "bearerTokenEnvVar": "GH_TOKEN"\n' +
  "    }\n" +
  "  }\n" +
  "}\n";

const github: McpServerSpec = {
  name: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  bearerTokenEnv: "GH_TOKEN",
};

describe("kimi's mcp.json — the golden bytes", () => {
  it("renders a pane's servers exactly as the host did before the move", () => {
    const keepdeck = { ...server("keepdeck"), args: [...server("keepdeck").args, "--client", "kd-mcp-pane-secret"] };
    expect(kimiMcpConfig([keepdeck, github])).toBe(GOLDEN_PANE);
  });

  it("renders a folder shared by two panes with no secret — the host withholds it", () => {
    // One file per folder: two panes there would both announce whichever
    // secret was written last. The host asks for none, the shim falls back
    // to the pane's bridge, and the file says nothing of either pane.
    const anonymous = kimiMcpConfig([server("keepdeck")]);
    expect(anonymous).toBe(
      '{\n  "mcpServers": {\n    "keepdeck": {\n      "command": "/bin/keepdeck",\n      "args": [\n        "--mcp-shim",\n        "/home/mcp.sock"\n      ]\n    }\n  }\n}\n',
    );
    expect(anonymous).not.toContain("--client");
  });
});

describe("kimi's mcp.json", () => {
  it("keys every server by name in the shape kimi's loader reads", () => {
    const written = JSON.parse(kimiMcpConfig([server("keepdeck"), server("mnemo")]));
    expect(written).toEqual({
      mcpServers: {
        keepdeck: { command: "/bin/keepdeck", args: ["--mcp-shim", "/home/mcp.sock"] },
        mnemo: { command: "/bin/keepdeck", args: ["--mcp-shim", "/home/mcp.sock"] },
      },
    });
  });

  it("keeps a passthrough name out of the file — kimi inherits", () => {
    const written = JSON.parse(kimiMcpConfig([{ ...server("gh"), envPassthrough: ["GH_TOKEN"] }]));
    expect(written.mcpServers.gh).toEqual({ command: "/bin/keepdeck", args: ["--mcp-shim", "/home/mcp.sock"] });
  });

  it("declares a remote server by transport, token through kimi's own field", () => {
    // kimi's loader discriminates on `transport` and reads the token from the
    // variable `bearerTokenEnvVar` names — its native way to keep a secret
    // out of a file on disk.
    const written = JSON.parse(
      kimiMcpConfig([{ ...github, headers: { "X-Org": "keepdeck" } }]),
    );
    expect(written.mcpServers.github).toEqual({
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { "X-Org": "keepdeck" },
      bearerTokenEnvVar: "GH_TOKEN",
    });
  });

  it("writes only what a remote server declares", () => {
    const written = JSON.parse(
      kimiMcpConfig([{ name: "plain", transport: "http", url: "https://mcp.example/" }]),
    );
    expect(written.mcpServers.plain).toEqual({ transport: "http", url: "https://mcp.example/" });
  });
});

describe("kimiMcpArms — what the pane's cwd is given", () => {
  it("declares the file kimi reads, rendered from the pane's servers", () => {
    expect(kimiMcpArms({ servers: [server("keepdeck")] })).toEqual([
      { kind: "file", path: KIMI_MCP_PATH, content: kimiMcpConfig([server("keepdeck")]) },
    ]);
    expect(KIMI_MCP_PATH).toBe(".kimi-code/mcp.json");
  });

  it("declares nothing without servers, so a file an earlier launch planted is taken back", () => {
    expect(kimiMcpArms(undefined)).toEqual([]);
    expect(kimiMcpArms({ servers: [] })).toEqual([]);
  });
});
