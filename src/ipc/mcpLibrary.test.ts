import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invoke-key contract with src-tauri/src/mcp/library.rs. Every other
 * library test mocks THIS module, so nothing else exercises the actual
 * command names and argument keys — the guard the skills wire already
 * needed once (a silently mismatched key shipped, and every call failed).
 */
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(
    async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => null,
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import { sameMcpScope, type McpScope } from "../domain/mcp";
import { ipcMcpStorage } from "./mcpLibraryStorage";
import {
  deleteMcpServer,
  fetchMcpServers,
  forgetMcpWorkspace,
  renameMcpServer,
  saveMcpServer,
} from "./mcpLibrary";

describe("the MCP library invoke-key contract", () => {
  beforeEach(() => {
    tauri.invoke.mockClear();
    tauri.invoke.mockResolvedValue(null);
  });

  it("pins every command name and argument key", async () => {
    tauri.invoke.mockResolvedValueOnce([]);
    await fetchMcpServers();
    expect(tauri.invoke).toHaveBeenLastCalledWith("mcp_library_list");

    await saveMcpServer({ kind: "global" }, "github", "{}", false);
    expect(tauri.invoke).toHaveBeenLastCalledWith("mcp_library_save", {
      scope: "global",
      wsId: null,
      name: "github",
      content: "{}",
      expectNew: false,
    });

    await saveMcpServer({ kind: "workspace", wsId: "ws-2" }, "fresh", "{}", true);
    expect(tauri.invoke).toHaveBeenLastCalledWith("mcp_library_save", {
      scope: "workspace",
      wsId: "ws-2",
      name: "fresh",
      content: "{}",
      expectNew: true,
    });

    await deleteMcpServer({ kind: "workspace", wsId: "ws-2" }, "github");
    expect(tauri.invoke).toHaveBeenLastCalledWith("mcp_library_delete", {
      scope: "workspace",
      wsId: "ws-2",
      name: "github",
    });

    await renameMcpServer({ kind: "global" }, "old", "new");
    expect(tauri.invoke).toHaveBeenLastCalledWith("mcp_library_rename", {
      scope: "global",
      wsId: null,
      from: "old",
      to: "new",
    });

    await forgetMcpWorkspace("ws-2");
    expect(tauri.invoke).toHaveBeenLastCalledWith("mcp_library_forget_workspace", {
      wsId: "ws-2",
    });
  });

  it("round-trips a scope through the wire and back", async () => {
    // The wire's two columns and the domain's one scope are inverses; a
    // drift between them would file a workspace server as a global one.
    for (const scope of [
      { kind: "global" },
      { kind: "workspace", wsId: "ws-7" },
    ] satisfies McpScope[]) {
      await saveMcpServer(scope, "x", "{}", false);
      const sent = tauri.invoke.mock.lastCall?.[1] as { scope: "global" | "workspace"; wsId: string | null };
      tauri.invoke.mockResolvedValueOnce([{ ...sent, name: "x", content: "{}" }]);
      const [row] = await ipcMcpStorage.fetch();
      expect(sameMcpScope(row!.scope, scope)).toBe(true);
    }
  });

  it("the storage adapter hands rows up with a domain scope, not wire columns", async () => {
    tauri.invoke.mockResolvedValueOnce([
      { scope: "global", wsId: null, name: "github", content: "{}" },
    ]);
    expect(await ipcMcpStorage.fetch()).toEqual([
      { scope: { kind: "global" }, name: "github", content: "{}" },
    ]);
  });
});
