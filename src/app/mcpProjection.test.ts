import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc/app", () => ({
  fetchAppInfo: () =>
    Promise.resolve({ name: "KeepDeck", version: "9.9.9", updater: false }),
}));

import { createCommandRegistry, type CommandSource } from "../domain/commands";
import { createMcpLineHandler } from "./mcpProjection";

describe("createMcpLineHandler", () => {
  it("executes registry commands as the external mcp source", async () => {
    const registry = createCommandRegistry();
    let seen: CommandSource | null = null;
    registry.register({
      id: "workspace.list",
      title: "List workspaces",
      args: [],
      run: (_args, source) => {
        seen = source;
        return [];
      },
    });
    const handler = createMcpLineHandler(registry);

    const reply = await handler(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "workspace_list" },
      }),
    );

    expect(seen).toEqual({ kind: "external", client: "mcp" });
    expect(JSON.parse(reply!).result.isError).toBe(false);
    // The call is in the journal like every other invoker's — the audit
    // trail is the point of routing through the registry.
    const journal = registry.journal();
    expect(journal[journal.length - 1]?.source).toEqual({
      kind: "external",
      client: "mcp",
    });
  });

  it("serves the fetched identity once it lands", async () => {
    const handler = createMcpLineHandler(createCommandRegistry());
    await Promise.resolve(); // let the identity fetch settle
    const reply = await handler(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }),
    );
    expect(JSON.parse(reply!).result.serverInfo).toEqual({
      name: "KeepDeck",
      version: "9.9.9",
    });
  });
});
