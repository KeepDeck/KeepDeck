import type { KeepDeckPlugin } from "@keepdeck/plugin-api";
import { setRuntime } from "./runtime";
import { GitTab } from "./components/GitTab";

/** The Git built-in plugin: one dock tab with a live changes view per
 * worktree, on the plugin API's git service. */
const activate: KeepDeckPlugin["activate"] = (ctx) => {
  setRuntime(ctx);
  ctx.ui.registerDockTab({ id: "git", label: "Git", Component: GitTab });
};

const deactivate = () => setRuntime(null);

export default { activate, deactivate } satisfies KeepDeckPlugin;
