/**
 * The Files built-in plugin — a dock tab that browses the workspace file tree
 * and previews file contents over the plugin API's `fs` service. Pure UI plus
 * `services.fs` reads: no sessions, no ports, nothing to reap, so `activate`
 * just stashes the context (the host-mounted tab tree reads it back through the
 * runtime holder) and registers the tab.
 */
import type { KeepDeckPlugin, PluginContext } from "@keepdeck/plugin-api";
import { setRuntime } from "./runtime";
import { FilesTab } from "./components/FilesTab";

const activate: KeepDeckPlugin["activate"] = (ctx: PluginContext) => {
  setRuntime(ctx);
  ctx.ui.registerDockTab({ id: "files", label: "Files", Component: FilesTab });
};

const deactivate: KeepDeckPlugin["deactivate"] = () => {
  setRuntime(null);
};

const plugin: KeepDeckPlugin = { activate, deactivate };

export default plugin;
