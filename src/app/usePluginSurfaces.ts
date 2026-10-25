import { useSyncExternalStore } from "react";
import type { WorkspaceSnapshot } from "@keepdeck/plugin-api";
import type { Workspace } from "../domain/deck";
import { overlayVisibility, subscribeOverlayVisibility } from "./overlayVisibility";
import { reportPluginCrash, type PluginCrash } from "./pluginHealth";
import { toWorkspaceSnapshot } from "./pluginSnapshots";
import { writePluginValue } from "./pluginValues";

/**
 * What host chrome does for the plugins it mounts: report a surface that
 * crashed (it badges the plugin's tab and opens its failure panel), write a
 * plugin's own settings value, and hand a plugin the workspace in the
 * contract's shape.
 */
export interface PluginSurfacesPort {
  reportCrash(
    pluginId: string,
    surfaceKind: PluginCrash["surfaceKind"],
    surfaceId: string,
    error: unknown,
  ): void;
  writeValue(pluginId: string, key: string, value: unknown): void;
  workspaceSnapshot(workspace: Workspace): WorkspaceSnapshot;
}

const port: PluginSurfacesPort = {
  reportCrash: (pluginId, surfaceKind, surfaceId, error) =>
    reportPluginCrash(pluginId, surfaceKind, surfaceId, error),
  writeValue: (pluginId, key, value) => writePluginValue(pluginId, key, value),
  workspaceSnapshot: (workspace) => toWorkspaceSnapshot(workspace),
};

/** The plugin-surfaces port. Stable across renders. */
export function usePluginSurfaces(): PluginSurfacesPort {
  return port;
}

/** Which plugin overlays are shown, by `pluginId:overlayId` — live. */
export function useOverlayVisibility(): ReadonlyMap<string, boolean> {
  return useSyncExternalStore(subscribeOverlayVisibility, overlayVisibility);
}
