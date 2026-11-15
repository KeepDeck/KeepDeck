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
  /** Ask to put the workspace away — the confirm comes first. */
  onArchive(): void;
  /** Open the Workspaces window on this workspace's page. */
  onSettings(): void;
  onClose(): void;
  /** A rename was asked for from elsewhere — a mark's menu — and the crumb,
   * where the name is, starts its field and says it has. */
  renameAsked: boolean;
  onRenameAsked(): void;
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
  archive: "Archive…",
  settings: "Workspace settings…",
  close: "Close workspace",
  /** A mark's right-click menu, named for its workspace. */
  markMenu: (name: string) => `Workspace ${name}`,
  renameField: "Workspace name",
  /** The name as a way back from a team to the workspace's team cards. */
  up: (name: string) => `Back to the teams of ${name}`,
} as const;

/** One line of a workspace's menu, described — the surface performs it. A
 * move carries where it goes, or null when that end of the column is
 * already reached and the line is refused. `separatorBefore` starts a new
 * group of acts. */
export type WorkspaceMenuItem = { id: string; label: string; disabled: boolean; separatorBefore: boolean } & (
  | { kind: "rename" }
  | { kind: "move"; place: WorkspacePlace | null }
  | { kind: "settings" }
  | { kind: "archive" }
  | { kind: "close" }
);

/** Where a workspace's menu is opened: its mark's right-click, or the
 * crumb's ⋯ — the same acts either way, arranged for where they are. */
export type WorkspaceMenuSurface = "mark" | "crumb";

/** The group each surface leads with: a mark is a thing to put away or
 * keep, the crumb the workspace in front of the person, to name and place. */
const ORDER: Record<WorkspaceMenuSurface, readonly (readonly WorkspaceMenuItem["kind"][])[]> = {
  mark: [["settings", "archive"], ["rename", "move"], ["close"]],
  crumb: [["rename", "move"], ["settings", "archive"], ["close"]],
};

/** A workspace's menu — ONE set of lines, the same refusals, in the order
 * its surface offers them. */
export function workspaceMenuView(
  target: Pick<ActiveWorkspace, "moveUp" | "moveDown">,
  surface: WorkspaceMenuSurface,
): WorkspaceMenuItem[] {
  const lines: Record<WorkspaceMenuItem["kind"], WorkspaceMenuItem[]> = {
    rename: [{ id: "rename", kind: "rename", label: WORKSPACE_WORDS.rename, disabled: false, separatorBefore: false }],
    move: [
      {
        id: "up",
        kind: "move",
        label: WORKSPACE_WORDS.moveUp,
        place: target.moveUp,
        disabled: target.moveUp === null,
        separatorBefore: false,
      },
      {
        id: "down",
        kind: "move",
        label: WORKSPACE_WORDS.moveDown,
        place: target.moveDown,
        disabled: target.moveDown === null,
        separatorBefore: false,
      },
    ],
    settings: [{ id: "settings", kind: "settings", label: WORKSPACE_WORDS.settings, disabled: false, separatorBefore: false }],
    archive: [{ id: "archive", kind: "archive", label: WORKSPACE_WORDS.archive, disabled: false, separatorBefore: false }],
    close: [{ id: "close", kind: "close", label: WORKSPACE_WORDS.close, disabled: false, separatorBefore: false }],
  };
  return ORDER[surface].flatMap((group, g) =>
    group.flatMap((kind) => lines[kind]).map((line, i) => ({ ...line, separatorBefore: g > 0 && i === 0 })),
  );
}
