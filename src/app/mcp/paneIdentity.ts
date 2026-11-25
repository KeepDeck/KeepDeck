/**
 * The pane an admitted MCP caller speaks for, as the journal will name it.
 *
 * Who the caller is was decided in Rust, on every line: the socket door asks
 * the sessions machine whether the process runs in a live pane's terminal
 * and that terminal's session holds the secret it named
 * (src-tauri/src/mcp/bridge.rs, keepdeck-pty's `judge_caller`). A caller that
 * is no pane's never reaches the page. What is left here is the deck's half:
 * the pane as it reads now. A pane the deck no longer holds, because it left
 * while the request crossed, answers null, and the call is refused.
 */
import type { McpCaller } from "../../domain/mcp";
import { findWorkspaceOfPane, paneDisplayTitle, type Workspace } from "../../domain/deck";

/** How a pane reads in the journal at the moment it acted. */
export interface McpPaneIdentity {
  id: string;
  workspaceId: string;
  label: string;
}

export interface PaneIdentityDeps {
  /** The deck as it is NOW: the label is a snapshot taken at CALL time, so
   * a journal entry stays readable after the pane is renamed or closed. */
  workspaces(): Workspace[];
  /** The agent catalog's pretty labels, read per call — a plugin can be
   * installed or removed while the deck is up. */
  agents(): readonly { id: string; label: string }[];
}

export function createPaneIdentity(
  deps: PaneIdentityDeps,
): (caller: McpCaller) => McpPaneIdentity | null {
  return ({ pane: paneId }) => {
    const workspaces = deps.workspaces();
    const workspace = findWorkspaceOfPane(workspaces, paneId);
    const index = workspace?.panes.findIndex((pane) => pane.id === paneId) ?? -1;
    const pane = index >= 0 ? workspace?.panes[index] : undefined;
    if (!workspace || !pane) return null;
    return {
      id: paneId,
      workspaceId: workspace.id,
      label: paneDisplayTitle(pane, index, deps.agents()),
    };
  };
}
