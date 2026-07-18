import { findWorkspaceByRef, type Workspace } from "../domain/deck";
import type {
  NotificationSource,
  NotificationWorkspace,
} from "../domain/notifications";

/** Resolve a notification's workspace lifetime, never merely its reusable id. */
export function workspaceForNotification(
  workspaces: Workspace[],
  ref: NotificationWorkspace,
): Workspace | null {
  return findWorkspaceByRef(workspaces, ref) ?? null;
}

/** A workspace-bound dock target is valid only after that exact workspace
 * lifetime resolved. Untargeted plugin notifications may reveal a global dock
 * tab directly. */
export function shouldRevealPluginDock(
  source: NotificationSource,
  preciseTargetResolved: boolean,
): source is Extract<NotificationSource, { type: "plugin" }> & {
  dockTab: string;
} {
  return (
    source.type === "plugin" &&
    source.dockTab !== undefined &&
    (source.workspace === undefined || preciseTargetResolved)
  );
}

/** Resolve only Settings destinations. More precise pane, workspace and dock
 * targets stay with App's deck navigation. Plugin ids are host-owned, so a
 * plugin notification cannot redirect to another plugin's page. */
export function settingsSectionForNotification(
  source: NotificationSource,
  preciseTargetResolved = true,
): string | null {
  if (source.type === "app") return "updates";
  if (
    source.type === "plugin" &&
    ((source.workspace === undefined && source.dockTab === undefined) ||
      !preciseTargetResolved)
  ) {
    return `plugin:${source.pluginId}`;
  }
  return null;
}
