/**
 * The Run built-in plugin — the app's Run panel, ported off the host's own
 * state onto the plugin API. `activate` builds a per-activation run manager
 * over `ctx.services` (PTY spawn + port allocation), stashes it with the
 * context in a module-level holder the dock-tab tree reads back, and registers
 * the Run dock tab. Presets live in the plugin's per-workspace storage slot;
 * everything else (sessions, the live log) is transient, exactly as the legacy
 * feature was.
 */
import type { KeepDeckPlugin, PluginContext } from "@keepdeck/plugin-api";
import { createRunManager } from "./manager";
import { peekRuntime, setRuntime } from "./runtime";
import { RunTab } from "./components/RunTab";

const activate: KeepDeckPlugin["activate"] = (ctx: PluginContext) => {
  const manager = createRunManager(ctx.services, ctx.log);
  // The tab tree is mounted by the host (it can't be handed props), so the
  // manager and context reach it through this module-level holder.
  setRuntime({ manager, ctx });

  ctx.ui.registerDockTab({
    id: "run",
    label: "Run",
    Component: RunTab,
  });

  // A workspace closing takes its runs with it — nothing may leak. (The
  // subscription auto-disposes at deactivation, per the context contract.)
  ctx.events.onWorkspaceClosed(({ wsId }) => manager.stopWorkspaceRuns(wsId));
};

const deactivate: KeepDeckPlugin["deactivate"] = () => {
  // NEW behaviour, deliberate: disabling the Run plugin KILLS its sessions.
  // The context's disposables reclaim the tab and the event subscription, but
  // the live PTYs are the plugin's own resource — exactly what `deactivate`
  // exists for — so reap them here rather than orphaning dev servers.
  peekRuntime()?.manager.stopAll();
  setRuntime(null);
};

const plugin: KeepDeckPlugin = { activate, deactivate };

export default plugin;
