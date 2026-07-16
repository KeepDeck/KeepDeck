import type { NotificationSource } from "../domain/notifications";

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
    ((source.wsId === undefined && source.dockTab === undefined) ||
      !preciseTargetResolved)
  ) {
    return `plugin:${source.pluginId}`;
  }
  return null;
}
