// FIRST, before anything that reaches the mocked IPC — see testSupport.
import {
  HOST,
  resetCoreCommandTestState,
  setup,
  twoWorkspaces,
  workspace,
} from "./testSupport";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRegistry, CommandSource } from "../../domain/commands";
import { handleMcpLine, type McpServerBody } from "../../domain/mcp";
import type { McpLibraryRow } from "../mcpLibrary";
import { recordsOf, recordOf, stringOf } from "../../testing/values.test-support";

beforeEach(() => {
  resetCoreCommandTestState();
});

/** An agent calling from its own pane, in `wsId`. */
const paneIn = (wsId: string): CommandSource => ({
  kind: "external",
  client: "claude",
  pane: { id: "p1", workspaceId: wsId, label: "Claude 1" },
});

const github: McpServerBody = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
};

const row = (over: Partial<McpLibraryRow> = {}): McpLibraryRow => ({
  scope: { kind: "global" },
  name: "github",
  verdict: { kind: "ok", body: github },
  ...over,
});

/** The MCP-library tools as an MCP client sees them, driven through the real
 * projection over the real registry — `inputSchema` by tool name. */
async function projectMcpTools(registry: CommandRegistry): Promise<Map<string, unknown>> {
  const reply = await handleMcpLine(
    {
      list: () => registry.list(),
      execute: (id, args) => registry.execute(id, args, HOST),
    },
    () => ({ name: "KeepDeck", version: "test" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    { pane: "pane-1" },
  );
  const parsed = recordOf(JSON.parse(reply ?? "{}"), "tools reply");
  const tools = recordsOf(recordOf(parsed.result, "tools result").tools, "tools");
  return new Map(
    tools
      .filter((tool) => stringOf(tool.name, "tool name").startsWith("mcp_"))
      .map((tool) => [stringOf(tool.name, "tool name"), tool.inputSchema]),
  );
}

describe("the MCP-library set as MCP tools", () => {
  it("projects every command, with the args an agent has to send", async () => {
    const { registry } = setup([workspace({})]);
    const tools = await projectMcpTools(registry);

    expect([...tools.keys()].sort()).toEqual([
      "mcp_create",
      "mcp_delete",
      "mcp_list",
      "mcp_read",
      "mcp_rename",
      "mcp_update",
    ]);
    // ONE spec argument carries the whole definition: the transports differ
    // in their fields and the projection's arguments are flat primitives.
    expect(tools.get("mcp_create")).toEqual({
      type: "object",
      properties: {
        scope: { type: "string", description: expect.stringContaining("global") },
        name: { type: "string", description: expect.any(String) },
        spec: { type: "string", description: expect.stringContaining('"transport"') },
      },
      required: ["scope", "name", "spec"],
    });
  });
});

describe("mcp.list and mcp.read", () => {
  it("names each server's variables and never their values", async () => {
    // A listing leaves through a door any client may open; the token that
    // reaches the server through its environment must not reach the caller.
    const { registry, mcpLibrary } = setup([workspace({})]);
    vi.mocked(mcpLibrary.list).mockResolvedValue([
      row(),
      row({ name: "broken", verdict: { kind: "malformed", reason: "unknown field \"x\"" } }),
    ]);

    const result = await registry.execute("mcp.list", { scope: "global" }, HOST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          name: "github",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
        },
        { name: "broken", malformed: 'unknown field "x"' },
      ]);
      expect(JSON.stringify(result.value)).not.toContain("ghp_secret");
    }
    expect(mcpLibrary.list).toHaveBeenCalledWith({ kind: "global" });
  });

  it("reads one server the same way, in the scope asked", async () => {
    const { registry, mcpLibrary } = setup(twoWorkspaces());
    vi.mocked(mcpLibrary.read).mockResolvedValue({
      name: "remote",
      body: { transport: "http", url: "https://mcp.example/", headers: {}, bearerToken: "t" },
    });

    const result = await registry.execute(
      "mcp.read",
      { scope: "workspace", name: "remote" },
      paneIn("ws-2"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        name: "remote",
        transport: "http",
        url: "https://mcp.example/",
        headers: {},
        bearerToken: true,
      });
    }
    // The caller's OWN workspace, not the one on screen (ws-1 is active).
    expect(mcpLibrary.read).toHaveBeenCalledWith({ kind: "workspace", wsId: "ws-2" }, "remote");
  });
});

describe("mcp.create and mcp.update", () => {
  it("reads the spec with the file's own codec and hands the library a draft", async () => {
    const { registry, mcpLibrary } = setup([workspace({})]);

    const result = await registry.execute(
      "mcp.create",
      { scope: "global", name: "github", spec: JSON.stringify(github) },
      HOST,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ name: "github" });
    expect(mcpLibrary.create).toHaveBeenCalledWith(
      { kind: "global" },
      { name: "github", body: github },
      null,
    );
  });

  it("refuses a spec the codec cannot carry, in the codec's words, before any call", async () => {
    const { registry, mcpLibrary } = setup([workspace({})]);

    const result = await registry.execute(
      "mcp.create",
      {
        scope: "global",
        name: "github",
        spec: '{"transport":"stdio","command":"npx","startup_timeout_sec":"30"}',
      },
      HOST,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('spec: unknown field "startup_timeout_sec"');
    expect(mcpLibrary.create).not.toHaveBeenCalled();
  });

  it("updates through the library, which refuses what is not there", async () => {
    const { registry, mcpLibrary } = setup([workspace({})]);
    vi.mocked(mcpLibrary.update).mockRejectedValue(new Error('No server "github" in the global library'));

    const result = await registry.execute(
      "mcp.update",
      { scope: "global", name: "github", spec: JSON.stringify(github) },
      HOST,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('No server "github"');
    expect(mcpLibrary.update).toHaveBeenCalledWith({ kind: "global" }, { name: "github", body: github }, null);
  });
});

/**
 * The library's door refuses a writer the lifecycle has forgotten, under its
 * own lock (integration row B26) — so an agent's write names its pane, and a
 * person's names nobody.
 */
describe("an agent's MCP library write names its writer", () => {
  it("create and delete from a pane carry that pane; the host's carry no writer", async () => {
    const { registry, mcpLibrary } = setup([workspace({})]);

    await registry.execute("mcp.create", { scope: "global", name: "github", spec: JSON.stringify(github) }, paneIn("ws-1"));
    await registry.execute("mcp.delete", { scope: "global", name: "github" }, paneIn("ws-1"));
    await registry.execute("mcp.delete", { scope: "global", name: "github" }, HOST);

    const writer = expect.objectContaining({ workspace: "ws-1", pane: "p1" });
    expect(mcpLibrary.create).toHaveBeenCalledWith({ kind: "global" }, { name: "github", body: github }, writer);
    expect(mcpLibrary.remove).toHaveBeenNthCalledWith(1, { kind: "global" }, "github", writer);
    expect(mcpLibrary.remove).toHaveBeenNthCalledWith(2, { kind: "global" }, "github", null);
  });
});

describe("mcp.rename and mcp.delete", () => {
  it("rename moves within the scope and answers the new name", async () => {
    const { registry, mcpLibrary } = setup([workspace({})]);

    const result = await registry.execute(
      "mcp.rename",
      { scope: "global", from: "github", to: "gh" },
      HOST,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ name: "gh" });
    expect(mcpLibrary.rename).toHaveBeenCalledWith({ kind: "global" }, "github", "gh", null);
  });

  it("delete removes within the scope and echoes the name", async () => {
    const { registry, mcpLibrary } = setup(twoWorkspaces());

    const result = await registry.execute(
      "mcp.delete",
      { scope: "workspace", name: "github" },
      HOST,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ name: "github" });
    // A host caller's "this workspace" is the one on screen.
    expect(mcpLibrary.remove).toHaveBeenCalledWith({ kind: "workspace", wsId: "ws-1" }, "github", null);
  });
});
