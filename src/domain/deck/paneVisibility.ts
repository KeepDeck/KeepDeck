import type { WorkspaceView } from "./workspaceView";
import { resolveFocus, type Pane } from "./panes";

/** The view fields that determine whether a pane body participates in layout. */
export type PaneVisibilityView = Pick<
  WorkspaceView,
  "focus" | "select" | "minimized" | "suspendedTray"
>;

/**
 * Why a pane is off the grid: minimized by hand, or placed in the tray by a
 * suspend. Each is a list on the view and comes off by its own action, and a
 * pane can carry both after a suspend from the grid. The maximize spotlight
 * is deliberately NOT a reason: it hides nothing from layout — every live
 * pane stays a participant and is merely covered on render — and calling it
 * one would hand `resolveFocus` a single pane and lose the maximize.
 */
export type HideReason = "minimized" | "suspendedTray";

/** Every reason, in the order they are reported — and removed. Minimized
 * first on purpose: the tray restore drops the maximize only for a pane that
 * is no longer minimized, so a reveal that walks this order leaves no stale
 * spotlight for its re-read to find. */
const HIDE_REASONS: readonly HideReason[] = ["minimized", "suspendedTray"];

/** Every reason `paneId` is off the grid; empty when it is on it. The one
 * reading of the view's two lists: the layout keeps a pane with no reason,
 * and a reveal removes each reason it finds by that reason's own action. */
export function hiddenBy(
  view: Pick<WorkspaceView, HideReason> | undefined,
  paneId: string,
): readonly HideReason[] {
  return HIDE_REASONS.filter((reason) => view?.[reason]?.includes(paneId) ?? false);
}

/** The panes on the grid: everything with no reason to be off it. The same
 * array back when nothing is hidden, so a render keyed on it stays put. */
export function visiblePanes(
  panes: Pane[],
  view: PaneVisibilityView | undefined,
): Pane[] {
  const live = panes.filter((pane) => hiddenBy(view, pane.id).length === 0);
  return live.length === panes.length ? panes : live;
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
