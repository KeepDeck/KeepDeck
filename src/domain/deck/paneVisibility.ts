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

/** Panes available to the current layout. Manual minimizes are a Grid-only
 * concern; suspended tray placement applies to both Grid and List. */
export function visiblePanes(
  panes: Pane[],
  view: PaneVisibilityView | undefined,
  minimizeOn: boolean,
): Pane[] {
  const hiddenIds = [
    ...(minimizeOn ? (view?.minimized ?? []) : []),
    ...(view?.suspendedTray ?? []),
  ];
  return partitionPanes(panes, hiddenIds).live;
}

/** Resolve the pane the UI is actually presenting as selected. List always
 * expands a live pane; Grid only falls back when a suspended tray transition
 * hid the stored selection or left one unambiguous live pane. */
export function resolveSelectedPaneId(
  panes: Pane[],
  view: PaneVisibilityView | undefined,
  layout: "grid" | "list",
  minimizeOn: boolean,
): string | undefined {
  const live = visiblePanes(panes, view, minimizeOn);
  if (live.some((pane) => pane.id === view?.select)) return view?.select;
  if (
    layout === "list" ||
    view?.suspendedTray?.includes(view.select ?? "") ||
    live.length === 1
  ) {
    return live[0]?.id;
  }
  return undefined;
}

/**
 * Whether a pane BODY is rendered by the current layout. Callers own the
 * workspace/modal/overlay half of visibility; this keeps DeckStage,
 * notifications and dock context on the same pane-placement decision.
 */
export function paneOnScreen(
  panes: Pane[],
  view: PaneVisibilityView | undefined,
  layout: "grid" | "list",
  minimizeOn: boolean,
  paneId: string,
): boolean {
  const live = visiblePanes(panes, view, minimizeOn);
  if (layout === "list") {
    return resolveSelectedPaneId(
      panes,
      view,
      layout,
      minimizeOn,
    ) === paneId;
  }
  if (!live.some((pane) => pane.id === paneId)) return false;
  const focused = resolveFocus(live, view?.focus);
  return focused === null || focused === paneId;
}
