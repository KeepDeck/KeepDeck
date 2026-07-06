import type { PluginContext } from "./context.ts";

/**
 * The runtime half of a plugin: its bundle's default export. `activate` runs
 * when the host decides the plugin is needed (contribution summaries in the
 * manifest let that be lazy); everything registered through the context is
 * torn down automatically on deactivation. `deactivate` exists only for
 * resources the context doesn't know about (a plugin's own timers, sockets,
 * child sessions).
 */
export interface KeepDeckPlugin {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
