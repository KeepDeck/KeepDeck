import { errorMessage, type PluginWorkspaces, type WorkspaceRef } from "@keepdeck/plugin-api";
import type { Workspace } from "../domain/deck";
import { workspaceInstanceOf } from "../domain/workspaceInstance";

/**
 * The owner of plugins' private per-workspace directories: it hands one out
 * (`ctx.workspaces.dir`), remembers which it handed to which plugin — those
 * are the write roots the plugin holds on their strength — and lets them go
 * with their workspaces.
 *
 * A directory is handed out only for a workspace the deck holds under the
 * exact lifetime the ref names: a stale ref cannot make a directory a later
 * workspace with the same id would inherit.
 */
export interface PluginWorkspaceDirs {
  /** `ctx.workspaces` for one plugin. */
  forPlugin(pluginId: string): PluginWorkspaces;
  /** The directories `pluginId` was handed — its write roots beside the
   * manifest's declared ones. */
  rootsOf(pluginId: string): readonly string[];
  /** Drop every plugin's directory of a workspace the deck no longer holds,
   * and the roots that named them. False when the native prune failed (the
   * sweep then tries again). */
  prune(liveWsIds: readonly string[]): Promise<boolean>;
}

export interface PluginWorkspaceDirsDeps {
  workspaces(): readonly Workspace[];
  create(pluginId: string, wsId: string): Promise<string>;
  prune(liveWsIds: readonly string[]): Promise<void>;
  warn(message: string): void;
}

export function createPluginWorkspaceDirs(deps: PluginWorkspaceDirsDeps): PluginWorkspaceDirs {
  /** pluginId → wsId → directory. */
  const granted = new Map<string, Map<string, string>>();

  function live(ref: WorkspaceRef): Workspace | undefined {
    const instance = workspaceInstanceOf(ref.instance);
    return deps.workspaces().find((ws) => ws.id === ref.id && ws.instance === instance);
  }

  return {
    forPlugin(pluginId) {
      return {
        async dir(ref) {
          const workspace = live(ref);
          if (!workspace) throw new Error(`workspace "${ref.id}" is gone`);
          const dir = await deps.create(pluginId, workspace.id);
          const dirs = granted.get(pluginId) ?? new Map<string, string>();
          dirs.set(workspace.id, dir);
          granted.set(pluginId, dirs);
          return dir;
        },
      };
    },
    rootsOf(pluginId) {
      return [...(granted.get(pluginId)?.values() ?? [])];
    },
    async prune(liveWsIds) {
      const alive = new Set(liveWsIds);
      for (const dirs of granted.values()) {
        for (const wsId of [...dirs.keys()]) if (!alive.has(wsId)) dirs.delete(wsId);
      }
      try {
        await deps.prune([...alive]);
        return true;
      } catch (e) {
        deps.warn(`plugin workspaces prune failed: ${errorMessage(e)}`);
        return false;
      }
    },
  };
}
