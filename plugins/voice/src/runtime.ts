import type { PluginContext } from "@keepdeck/plugin-api";
import type { VoiceController } from "./controller";

/**
 * The runtime holder — `activate` stashes the context and controller here,
 * the host-mounted components read them back (the Files plugin's idiom: the
 * host owns the React tree, so props can't carry plugin internals).
 */
let current: { ctx: PluginContext; controller: VoiceController } | null = null;

export function setRuntime(
  ctx: PluginContext,
  controller: VoiceController,
): void {
  current = { ctx, controller };
}

export function clearRuntime(): void {
  current = null;
}

export function runtime(): { ctx: PluginContext; controller: VoiceController } {
  if (!current) throw new Error("voice plugin is not active");
  return current;
}
