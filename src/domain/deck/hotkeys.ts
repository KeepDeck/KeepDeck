import type { AgentInfo } from "../agents";
import type { Pane } from "./panes";
import { paneDisplayTitle, partitionPanes, resolveFocus } from "./panes";
import type { WorkspaceView } from "./reducer";
import type { Workspace } from "./workspaces";

/** What the close hotkey should close: an agent pane (with its confirm-dialog
 * label) or, in an empty workspace, the workspace itself. */
export type CloseTarget =
  | { kind: "agent"; wsId: string; paneId: string; label: string }
  | { kind: "workspace"; wsId: string };

/** The workspace's VISIBLE panes: the ones the minimized set doesn't hide.
 * `minimizeOn` says whether that set is in force — it's ignored exactly where
 * rendering ignores it (the list layout, or the "none" minimize style), so the
 * hotkeys and the screen always agree on what's visible. */
function visiblePanes(
  ws: Workspace,
  view: WorkspaceView | undefined,
  minimizeOn: boolean,
): Pane[] {
  return partitionPanes(ws.panes, minimizeOn ? view?.minimized : undefined).live;
}

/**
 * What ⌘W targets: the active workspace's selected pane, or its only VISIBLE
 * pane when nothing is selected (an unambiguous target — a solo pane never
 * even carries the selection highlight, [U2]). Minimized panes are never
 * targeted: a habituated confirm must not close an agent that isn't on
 * screen. An empty workspace has nothing but itself to close, so ⌘W targets
 * the workspace — same as the rail's close button. Null when there is no
 * active workspace or a stale/absent selection leaves several candidates.
 * Pure.
 */
export function closeHotkeyTarget(
  workspaces: Workspace[],
  activeId: string,
  viewByWs: Record<string, WorkspaceView>,
  agents: AgentInfo[],
  minimizeOn: boolean,
): CloseTarget | null {
  const ws = workspaces.find((w) => w.id === activeId);
  if (!ws) return null;
  if (ws.panes.length === 0) return { kind: "workspace", wsId: ws.id };
  const view = viewByWs[ws.id];
  const visible = visiblePanes(ws, view, minimizeOn);
  let pane = visible.find((p) => p.id === view?.select);
  if (!pane && visible.length === 1) pane = visible[0];
  if (!pane) return null;
  return {
    kind: "agent",
    wsId: ws.id,
    paneId: pane.id,
    // The label numbers by the pane's ORIGINAL position, like the header.
    label: paneDisplayTitle(pane, ws.panes.indexOf(pane), agents),
  };
}

/**
 * The pane the maximize hotkey should toggle. A maximized pane restores no
 * matter what the selection points at — the hotkey is a toggle, and only one
 * pane can be maximized. Otherwise the selected pane maximizes. Resolution
 * runs over the VISIBLE panes, mirroring the grid: with all-but-one minimized
 * the survivor is already full-size, and writing a focus the render masks
 * would spring a surprise maximize on the next restore. Null for a
 * visible-solo pane, a stale/absent selection among several panes, or no
 * active workspace. Pure.
 */
export function maximizeHotkeyTarget(
  workspaces: Workspace[],
  activeId: string,
  viewByWs: Record<string, WorkspaceView>,
  minimizeOn: boolean,
): { wsId: string; paneId: string } | null {
  const ws = workspaces.find((w) => w.id === activeId);
  if (!ws) return null;
  const view = viewByWs[ws.id];
  const visible = visiblePanes(ws, view, minimizeOn);
  if (visible.length <= 1) return null;
  const focused = resolveFocus(visible, view?.focus);
  if (focused) return { wsId: ws.id, paneId: focused };
  const selected = visible.find((p) => p.id === view?.select);
  return selected ? { wsId: ws.id, paneId: selected.id } : null;
}
