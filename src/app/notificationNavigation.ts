import { findWorkspace, type Workspace } from "../domain/deck";
import type {
  NotificationSource,
  NotificationWorkspace,
} from "../domain/notifications";

/** Resolve a notification's workspace lifetime, never merely its reusable id. */
export function workspaceForNotification(
  workspaces: Workspace[],
  ref: NotificationWorkspace,
): Workspace | null {
  if (ref.instance === null) return null;
  const workspace = findWorkspace(workspaces, ref.id);
  return workspace?.instance === ref.instance ? workspace : null;
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
