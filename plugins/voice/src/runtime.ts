import type { PluginContext } from "@keepdeck/plugin-api";
import type { VoiceController } from "./controller";
import type { ModelDownloads } from "./downloads";
import type { ModelsStore } from "./models";

/**
 * The runtime holder — `activate` stashes the context, controller, download
 * manager, and models store here; the host-mounted components read them back
 * (the Files plugin's idiom: the host owns the React tree, so props can't
 * carry plugin internals). Everything here outlives any single component
 * mount, so state shared across views survives their unmounts.
 */
export interface VoiceRuntime {
  ctx: PluginContext;
  controller: VoiceController;
  downloads: ModelDownloads;
  models: ModelsStore;
}

let current: VoiceRuntime | null = null;

export function setRuntime(rt: VoiceRuntime): void {
  current = rt;
}

export function clearRuntime(): void {
  current = null;
}

export function runtime(): VoiceRuntime {
  if (!current) throw new Error("voice plugin is not active");
  return current;
}
