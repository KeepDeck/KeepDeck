import type { WorkspaceView } from "./workspaceView";
import {
  partitionPanes,
  resolveFocus,
  type Pane,
} from "./panes";

/** The view fields that determine whether a pane body participates in layout. */
export type PaneVisibilityView = Pick<
  WorkspaceView,
  "focus" | "select" | "minimized" | "suspendedTray"
>;

/** The panes on the grid: everything not minimized to the tray and not
 * placed there as suspended. */
export function visiblePanes(
  panes: Pane[],
  view: PaneVisibilityView | undefined,
): Pane[] {
  return partitionPanes(panes, [
    ...(view?.minimized ?? []),
    ...(view?.suspendedTray ?? []),
  ]).live;
}

/** Resolve the pane the UI is actually presenting as selected: the stored
 * selection while it is live, else the first live pane — but only when a
 * suspended-tray transition hid the stored selection, or one unambiguous
 * live pane is left. Any other stale selection resolves to none. */
export function resolveSelectedPaneId(
  panes: Pane[],
  view: PaneVisibilityView | undefined,
): string | undefined {
  const live = visiblePanes(panes, view);
  if (live.some((pane) => pane.id === view?.select)) return view?.select;
  if (view?.suspendedTray?.includes(view.select ?? "") || live.length === 1) {
    return live[0]?.id;
  }
  return undefined;
}

/**
 * Whether a pane BODY is rendered. Callers own the workspace/modal/overlay
 * half of visibility; this keeps DeckStage, notifications and dock context
 * on the same pane-placement decision.
 */
export function paneOnScreen(
  panes: Pane[],
  view: PaneVisibilityView | undefined,
  paneId: string,
): boolean {
  const live = visiblePanes(panes, view);
  if (!live.some((pane) => pane.id === paneId)) return false;
  const focused = resolveFocus(live, view?.focus);
  return focused === null || focused === paneId;
}
