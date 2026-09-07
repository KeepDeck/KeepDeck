/**
 * The MCP-server library as UI STATE — the generic library binding
 * ([`useLibraryState`]) configured for servers: which owner, how a row is
 * matched, and how the library is named in a notice.
 */
import { sameMcpRef, type McpScope, type McpServerDraft } from "../domain/mcp";
import type { McpLibraryRow } from "./mcpLibrary";
import { useAppRuntime } from "./runtimeContext";
import { useLibraryState, type LibraryState } from "./useLibraryState";

/** The generic state under the servers vocabulary: the rows are `servers`. */
export interface McpEditorState
  extends Omit<LibraryState<McpScope, McpLibraryRow, McpServerDraft>, "rows"> {
  /** The stored servers, each already judged; `null` while the first load is
   * in flight. */
  servers: McpLibraryRow[] | null;
}

export function useMcpLibrary(open: boolean): McpEditorState {
  const { rows, ...state } = useLibraryState<McpScope, McpLibraryRow, McpServerDraft>(
    useAppRuntime().mcpLibrary,
    open,
    {
      sameRef: sameMcpRef,
      noun: "MCP servers",
      logTag: "web:mcp",
    },
  );
  return { servers: rows, ...state };
}
