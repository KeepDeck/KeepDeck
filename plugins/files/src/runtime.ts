import type {
  PluginFileOpeners,
  PluginFs,
  PluginLogger,
  PluginOpener,
  PluginSettings,
  PluginUi,
} from "@keepdeck/plugin-api";

/** What the plugin needs from the host — the parts of its context it uses. */
export interface FilesPorts {
  ui: Pick<PluginUi, "registerDockTab" | "registerOverlay" | "setOverlayCovers">;
  settings: Pick<PluginSettings, "registerSection" | "read" | "onChange">;
  openers: PluginFileOpeners;
  services: { fs: PluginFs; opener: Pick<PluginOpener, "openUrl" | "openPath"> };
  log: PluginLogger;
}

/**
 * The activation's context, held at module scope. The dock-tab component tree
 * is mounted by the HOST (it can't be handed props for this), so the Files tab
 * and its children reach `ctx.services.fs` / `ctx.services.opener` / `ctx.log`
 * through `getRuntime()`. Cleared on `deactivate`. Tests set it directly with a
 * fake context via `setRuntime`.
 */
let ctx: FilesPorts | null = null;

export function setRuntime(next: FilesPorts | null): void {
  ctx = next;
}

/** The active context; throws if read before `activate` — a component rendered
 * without the plugin active is a wiring bug, not a recoverable state. */
export function getRuntime(): FilesPorts {
  if (!ctx) throw new Error("Files plugin: runtime read before activate()");
  return ctx;
}
