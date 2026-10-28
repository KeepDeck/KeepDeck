import { errorMessage, type PluginWorkspaces, type WorkspaceRef } from "@keepdeck/plugin-api";
import type { Workspace } from "../domain/deck";
import { workspaceInstanceOf } from "../domain/workspaceInstance";

/**
 * The owner of plugins' private per-workspace directories on this side: it
 * hands one out (`ctx.workspaces.dir`) only for a workspace the deck holds,
 * and lets them go with their workspaces. Which directories a plugin was
 * handed — write roots it holds on their strength — is kept natively, in its
 * grant, by the same calls.
 *
 * A directory is handed out only for a workspace the deck holds under the
 * exact lifetime the ref names: a stale ref cannot make a directory a later
 * workspace with the same id would inherit.
 */
export interface PluginWorkspaceDirs {
  /** `ctx.workspaces` for one plugin. */
  forPlugin(pluginId: string): PluginWorkspaces;
  /** Drop every plugin's directory of a workspace the deck no longer holds,
   * with the write roots that named them. False when the native prune
   * failed (the sweep then tries again). */
  prune(liveWsIds: readonly string[]): Promise<boolean>;
}

export interface PluginWorkspaceDirsDeps {
  workspaces(): readonly Workspace[];
  create(pluginId: string, wsId: string): Promise<string>;
  prune(liveWsIds: readonly string[]): Promise<void>;
  warn(message: string): void;
}

export function createPluginWorkspaceDirs(deps: PluginWorkspaceDirsDeps): PluginWorkspaceDirs {
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
          return deps.create(pluginId, workspace.id);
        },
      };
    },
    async prune(liveWsIds) {
      try {
        await deps.prune(liveWsIds);
        return true;
      } catch (e) {
        deps.warn(`plugin workspaces prune failed: ${errorMessage(e)}`);
        return false;
      }
    },
  };
}
