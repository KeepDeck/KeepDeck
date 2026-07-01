import type { AgentInfo } from "./agents";
import { paneDisplayTitle } from "./panes";
import type { Workspace } from "./workspaces";

/** What the close hotkey should close, plus the confirm-dialog label. */
export interface CloseTarget {
  wsId: string;
  paneId: string;
  label: string;
}

/**
 * The pane ⌘W targets: the active workspace's selected pane, or its only pane
 * when nothing is selected (a solo pane is unambiguous — it never even carries
 * the selection highlight, [U2]). Null when there is no active workspace, it
 * has no panes, or a stale/absent selection leaves several candidates. Pure.
 */
export function closeHotkeyTarget(
  workspaces: Workspace[],
  activeId: string,
  selectByWs: Record<string, string>,
  agents: AgentInfo[],
): CloseTarget | null {
  const ws = workspaces.find((w) => w.id === activeId);
  if (!ws || ws.panes.length === 0) return null;
  let index = ws.panes.findIndex((p) => p.id === selectByWs[ws.id]);
  if (index < 0 && ws.panes.length === 1) index = 0;
  if (index < 0) return null;
  const pane = ws.panes[index];
  return {
    wsId: ws.id,
    paneId: pane.id,
    label: paneDisplayTitle(pane, index, agents),
  };
}
