/**
 * What is painted over what, decided once.
 *
 * The composition root answered this with five expressions inline and then
 * answered it again for the notification probe, copying the same facts into
 * a ref by hand — the sync held by discipline, and a fourth layer would have
 * had to be added in both places or the probe would lie: a system banner
 * over a pane a dialog covers, or silence over one nothing covers. The
 * knowledge of z-order lived in comments beside the copies. It lives here,
 * as the one function both the render and the probe read.
 *
 * Z-ORDER, the part that is not obvious from the flags:
 *
 * - The workspace form has two shapes and only one is a modal layer. The
 *   CREATE variant rides a ModalOverlay portaled over the whole window; the
 *   zero-workspace variant renders in the deck overlay at z 10 and covers
 *   neither the top bar nor the rail. Counting the latter made the modal flag
 *   claim a layer the user could tab straight past.
 * - What can paint OVER the Stats dialog is a transaction confirm, or the
 *   CREATE form — portaled after stats at the same z-index, so DOM order puts
 *   it on top. Deliberately NOT `modal`: that contains the stats dialog
 *   itself and would make its own branch always false. And NOT the
 *   zero-workspace form, which sits UNDER the portaled dialog.
 * - A floating dock covers the panes only while it has tabs to show and a
 *   workspace to show them for.
 */
import type { DockMode } from "../domain/settings";

export interface LayeringInput {
  /** The CREATE variant of the workspace form is open. The zero-workspace
   * variant is not this: it is `workspaceCount === 0`. */
  creating: boolean;
  workspaceCount: number;
  /** A transaction is stacked over the app: an agent dialog, a close
   * confirm, a fork, a team, an error, a frozen notice. */
  dialogOpen: boolean;
  /** The dialog router has one of its own open: settings, statistics,
   * skills, artifacts. */
  anyDialogOpen: boolean;
  statsOpen: boolean;
  statsTab: string | null;
  tasksOpen: boolean;
  dockMode: DockMode;
  dockTabs: number;
  hasActive: boolean;
  /** A plugin overlay says it is painted over the whole window — a
   * full-window peek (`ui.setOverlayCovers`). */
  overlayCovers: boolean;
}

export interface WindowLayering {
  /** A modal layer is up: the CREATE form, a transaction, a router dialog,
   * or a plugin overlay covering the window. */
  modal: boolean;
  /** The floating dock is over the panes. */
  dockCovers: boolean;
  /** The panes may take keyboard focus: nothing modal, nothing docked over them. */
  panesInteractive: boolean;
  stats: {
    open: boolean;
    tab: string | null;
    /** Something is painted over the stats dialog — see the z-order note. */
    covered: boolean;
  };
  /** The Tasks dialog, covered by what covers any router dialog. */
  tasks: { open: boolean; covered: boolean };
}

/**
 * Whether a deep link into the stats dialog is already on screen: the dialog
 * open, nothing painted over it, and the tab the link names — when it names
 * one — the tab shown. The probe's stats branch, as a function the matrix can
 * ask; the historical mistake it pins is reading "covered" as `modal`, which
 * contains the stats dialog itself and silences the branch for good.
 */
export function statsDeepLinkOnScreen(
  stats: WindowLayering["stats"],
  tab: string | undefined,
): boolean {
  return stats.open && !stats.covered && (tab === undefined || stats.tab === tab);
}

/** Whether the Tasks dialog shows the person this workspace's board: open,
 * nothing painted over it, and the workspace the active one — the dialog
 * shows the active workspace's boards. */
export function tasksBoardOnScreen(
  tasks: WindowLayering["tasks"],
  workspaceId: string,
  activeId: string | null,
): boolean {
  return tasks.open && !tasks.covered && workspaceId === activeId;
}

export function layering(input: LayeringInput): WindowLayering {
  const formIsModalLayer = input.creating && input.workspaceCount > 0;
  // A covering overlay is a modal layer to everything that asks: hotkeys
  // pause, the doors close, a pane behind it is not on screen. It used to be
  // invisible here — a full-window diff had ⌘-hotkeys firing through it and
  // banners for the panes under it suppressed as if they were visible.
  const modal =
    formIsModalLayer || input.dialogOpen || input.anyDialogOpen || input.overlayCovers;
  // What paints over a router dialog: a transaction, or the CREATE form
  // (see the z-order note) — never the router dialog itself.
  const dialogCovered = input.dialogOpen || input.creating;
  const dockCovers =
    input.dockMode === "floating" && input.dockTabs > 0 && input.hasActive;
  return {
    modal,
    dockCovers,
    panesInteractive: !modal && !dockCovers,
    stats: {
      open: input.statsOpen,
      tab: input.statsTab,
      covered: dialogCovered,
    },
    tasks: { open: input.tasksOpen, covered: dialogCovered },
  };
}
