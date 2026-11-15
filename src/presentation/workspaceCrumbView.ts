/**
 * The bar's first crumb: the workspace on screen, and the one menu that
 * acts on it — decided apart from the crumb that draws it. The controller
 * composes a `WorkspaceCrumbView` from the strip's `ActiveWorkspace` and
 * the callbacks that own each act; the crumb maps it.
 */

import type { WorkspacePlace } from "../domain/deck";

/** The workspace on screen, as the bar's crumb names it and its menu acts
 * on it. */
export interface ActiveWorkspace {
  id: string;
  name: string;
  /** Where the menu can move it — the keyboard's way to do what a held
   * mark's drag does — or null at that end of the column. */
  moveUp: WorkspacePlace | null;
  moveDown: WorkspacePlace | null;
}

/** The crumb as the controller composes it and the bar passes it through. */
export interface WorkspaceCrumbView {
  view: ActiveWorkspace;
  /** Empty = back to the auto name, which the domain rename implements. */
  onRename(name: string): void;
  /** Move the workspace to `place` in the strip's column. */
  onMove(place: WorkspacePlace): void;
  onClose(): void;
  /** Back up to the team cards — the name is then a link — or null at the
   * cards already. */
  onUp: (() => void) | null;
}

/** The bar's crumb for the active workspace, and its menu. */
export const WORKSPACE_WORDS = {
  menu: (name: string) => `Workspace ${name} actions`,
  rename: "Rename",
  moveUp: "Move up",
  moveDown: "Move down",
  close: "Close workspace",
  renameField: "Workspace name",
  /** The name as a way back from a team to the workspace's team cards. */
  up: (name: string) => `Back to the teams of ${name}`,
} as const;

/** One line of the workspace's menu, described — the crumb performs it. A
 * move carries where it goes, or null when that end of the column is
 * already reached and the line is refused. */
export type WorkspaceMenuItem = { id: string; label: string; disabled: boolean } & (
  | { kind: "rename" }
  | { kind: "move"; place: WorkspacePlace | null }
  | { kind: "close" }
);

/** The workspace menu, in the order it is offered. */
export function workspaceMenuView(active: ActiveWorkspace): WorkspaceMenuItem[] {
  return [
    { id: "rename", kind: "rename", label: WORKSPACE_WORDS.rename, disabled: false },
    { id: "up", kind: "move", label: WORKSPACE_WORDS.moveUp, place: active.moveUp, disabled: active.moveUp === null },
    {
      id: "down",
      kind: "move",
      label: WORKSPACE_WORDS.moveDown,
      place: active.moveDown,
      disabled: active.moveDown === null,
    },
    { id: "close", kind: "close", label: WORKSPACE_WORDS.close, disabled: false },
  ];
}
