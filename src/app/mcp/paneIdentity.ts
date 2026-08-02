/**
 * Turning a connection's secret into the pane the journal will name.
 *
 * Three steps, and each belongs to a different owner: which pane minted this
 * secret is the spawn cache's, which workspace holds that pane is the deck's,
 * and how the pane reads to a person is the catalog's. Assembled here rather
 * than in the composition root, where it was sixty untested lines of exactly
 * this — a root should wire owners together, not BE one.
 *
 * A secret that no longer resolves reads as an anonymous client: a hand-wired
 * server, or a lingering child of a pane that is gone. That is the behaviour
 * that existed before panes could be named at all, and it is the right floor —
 * naming the wrong pane is worse than naming none.
 */
import { findWorkspaceOfPane, paneDisplayTitle, type Workspace } from "../../domain/deck";

/** How a pane reads in the journal at the moment it acted. */
export interface McpPaneIdentity {
  id: string;
  workspaceId: string;
  label: string;
}

export interface PaneIdentityDeps {
  /** The deck as it is NOW: the label is snapshot at CALL time, because
   * `pane-N` is a slot a later pane can inherit and a journal entry has to
   * stay readable. */
  workspaces(): Workspace[];
  /** Which pane's CURRENT plan carries this secret, or null. */
  paneOf(client: string): string | null;
  /** The agent catalog's pretty labels, read per call — a plugin can be
   * installed or removed while the deck is up. */
  agents(): readonly { id: string; label: string }[];
}

export function createPaneIdentity(
  deps: PaneIdentityDeps,
): (client: string) => McpPaneIdentity | null {
  return (client) => {
    const paneId = deps.paneOf(client);
    if (!paneId) return null;
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
