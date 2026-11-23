import { invoke } from "@tauri-apps/api/core";

/**
 * Plugins' private per-workspace directories, made natively
 * (`plugin_workspaces.rs`) and taken back by the lifecycle. The ids are the
 * host's — the registry's plugin id and the deck's workspace id — never a
 * plugin's words.
 */

export function pluginWorkspaceDir(pluginId: string, wsId: string): Promise<string> {
  return invoke<string>("plugin_workspace_dir", { pluginId, wsId });
}
