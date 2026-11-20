import { invoke } from "@tauri-apps/api/core";
import type { McpScope } from "../domain/mcp";

/** One stored library server (mirrors the Rust `McpServerDto`). */
export interface StoredMcpServer {
  scope: "global" | "workspace";
  wsId: string | null;
  name: string;
  content: string;
}

/** A scope in the shape the wire carries. Typed as the stored row's own two
 * fields, not an inferred literal, so this and the domain's `mcpScopeOf` —
 * which is exactly its inverse — cannot drift apart silently; the round trip
 * is pinned in this module's suite. */
const wire = (scope: McpScope): Pick<StoredMcpServer, "scope" | "wsId"> =>
  scope.kind === "global"
    ? { scope: "global", wsId: null }
    : { scope: "workspace", wsId: scope.wsId };

/** The raw library read — THROWS on a backend error, for callers that must
 * tell "empty" from "unreachable". */
export async function fetchMcpServers(): Promise<StoredMcpServer[]> {
  return await invoke<StoredMcpServer[]>("mcp_library_list");
}

/** Write one server's file. `expectNew` says this is a CREATE, and the
 * backend then refuses a name that is already taken — the check that cannot
 * be skipped by a read that failed. Throws on failure. */
export async function saveMcpServer(
  scope: McpScope,
  name: string,
  content: string,
  expectNew: boolean,
): Promise<void> {
  await invoke("mcp_library_save", { ...wire(scope), name, content, expectNew });
}

/** Remove one server's file. Throws on failure. */
export async function deleteMcpServer(scope: McpScope, name: string): Promise<void> {
  await invoke("mcp_library_delete", { ...wire(scope), name });
}

/** Rename one server by moving its file. Throws on failure (a name collision
 * included). */
export async function renameMcpServer(scope: McpScope, from: string, to: string): Promise<void> {
  await invoke("mcp_library_rename", { ...wire(scope), from, to });
}
