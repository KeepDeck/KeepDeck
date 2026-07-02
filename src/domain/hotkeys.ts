import type { AgentInfo } from "./agents";
import { paneDisplayTitle, resolveFocus } from "./panes";
import type { Workspace } from "./workspaces";

/** What the close hotkey should close: an agent pane (with its confirm-dialog
 * label) or, in an empty workspace, the workspace itself. */
export type CloseTarget =
  | { kind: "agent"; wsId: string; paneId: string; label: string }
  | { kind: "workspace"; wsId: string };

/**
 * What ⌘W targets: the active workspace's selected pane, or its only pane
 * when nothing is selected (a solo pane is unambiguous — it never even carries
 * the selection highlight, [U2]). An empty workspace has nothing but itself to
 * close, so ⌘W targets the workspace — same as the rail's close button. Null
 * when there is no active workspace or a stale/absent selection leaves several
 * candidates. Pure.
 */
export function closeHotkeyTarget(
  workspaces: Workspace[],
  activeId: string,
  selectByWs: Record<string, string>,
  agents: AgentInfo[],
): CloseTarget | null {
  const ws = workspaces.find((w) => w.id === activeId);
  if (!ws) return null;
  if (ws.panes.length === 0) return { kind: "workspace", wsId: ws.id };
  let index = ws.panes.findIndex((p) => p.id === selectByWs[ws.id]);
  if (index < 0 && ws.panes.length === 1) index = 0;
  if (index < 0) return null;
  const pane = ws.panes[index];
  return {
    kind: "agent",
    wsId: ws.id,
    paneId: pane.id,
    label: paneDisplayTitle(pane, index, agents),
  };
}

/**
 * The pane the maximize hotkey should toggle. A maximized pane restores no
 * matter what the selection points at — the hotkey is a toggle, and only one
 * pane can be maximized. Otherwise the selected pane maximizes. Null for a
 * solo pane (already full-size; a focus entry would just go stale), when the
 * selection is stale/absent among several panes, or with no active workspace.
 * Pure.
 */
export function maximizeHotkeyTarget(
  workspaces: Workspace[],
  activeId: string,
  focusByWs: Record<string, string>,
  selectByWs: Record<string, string>,
): { wsId: string; paneId: string } | null {
  const ws = workspaces.find((w) => w.id === activeId);
  if (!ws || ws.panes.length <= 1) return null;
  const focused = resolveFocus(ws.panes, focusByWs[ws.id]);
  if (focused) return { wsId: ws.id, paneId: focused };
  const selected = ws.panes.find((p) => p.id === selectByWs[ws.id]);
  return selected ? { wsId: ws.id, paneId: selected.id } : null;
}
