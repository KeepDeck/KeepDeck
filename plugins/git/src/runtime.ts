import type {
  PluginEvents,
  PluginKV,
  PluginFs,
  PluginGit,
  PluginLogger,
  PluginUi,
  WorkspaceRef,
} from "@keepdeck/plugin-api";

/** A workspace's slot as the tab uses it: read back untyped and validated on
 * the way in (`readSections`), written whole. */
export interface SectionsSlot {
  get: PluginKV["get"];
  set: PluginKV["set"];
}

/** What the plugin needs from the host — the parts of its context it uses. */
export interface GitPorts {
  storage: { workspace(workspace: WorkspaceRef): SectionsSlot };
  ui: Pick<PluginUi, "registerDockTab" | "registerOverlay" | "setOverlayCovers">;
  events: PluginEvents;
  services: { git: PluginGit; fs: Pick<PluginFs, "readFile"> };
  log: PluginLogger;
}

/**
 * The activation's context, held at module scope. The dock-tab component tree
 * is mounted by the HOST (it can't be handed props for this), so the Git tab
 * and its children reach `ctx.services.git` / `ctx.services.fs` / `ctx.log`
 * through `getRuntime()`. Cleared on `deactivate`. Tests set it directly with a
 * fake context via `setRuntime`.
 */
let ctx: GitPorts | null = null;

export function setRuntime(next: GitPorts | null): void {
  ctx = next;
}

/** The active context; throws if read before `activate` — a component rendered
 * without the plugin active is a wiring bug, not a recoverable state. */
export function getRuntime(): GitPorts {
  if (!ctx) throw new Error("Git plugin: runtime read before activate()");
  return ctx;
}

/** The active context, or null once `deactivate` has cleared it — for the
 * EFFECTS of surfaces the host is still tearing down. `deactivate` runs
 * before the host unmounts them, so a status tick can land in between and
 * re-run every effect keyed on it; one that asked `getRuntime()` then threw
 * inside React. Such an effect has nothing left to fetch or log: it returns. */
export function activeRuntime(): GitPorts | null {
  return ctx;
}
