/**
 * The Tauri side of the MCP library, as the library's own port — the same
 * split `skillsStorage.ts` makes: the module that owns the rules does not also
 * decode the wire, and `fetch` folds the DTO's two scope columns into one
 * `McpScope` so the wire's shape stops here.
 */
import { mcpScopeOf } from "../domain/mcp";
import type { McpStorage } from "../app/mcpLibrary";
import {
  deleteMcpServer,
  fetchMcpServers,
  renameMcpServer,
  saveMcpServer,
} from "./mcpLibrary";

export const ipcMcpStorage: McpStorage = {
  fetch: async () =>
    (await fetchMcpServers()).map((row) => ({
      scope: mcpScopeOf(row),
      name: row.name,
      content: row.content,
    })),
  save: saveMcpServer,
  rename: renameMcpServer,
  remove: deleteMcpServer,
};
