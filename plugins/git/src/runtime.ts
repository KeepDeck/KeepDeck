import type { PluginContext } from "@keepdeck/plugin-api";

/**
 * The activation's context, held at module scope. The dock-tab component tree
 * is mounted by the HOST (it can't be handed props for this), so the Git tab
 * and its children reach `ctx.services.git` / `ctx.services.fs` / `ctx.log`
 * through `getRuntime()`. Cleared on `deactivate`. Tests set it directly with a
 * fake context via `setRuntime`.
 */
let ctx: PluginContext | null = null;

export function setRuntime(next: PluginContext | null): void {
  ctx = next;
}

/** The active context; throws if read before `activate` — a component rendered
 * without the plugin active is a wiring bug, not a recoverable state. */
export function getRuntime(): PluginContext {
  if (!ctx) throw new Error("Git plugin: runtime read before activate()");
  return ctx;
}
