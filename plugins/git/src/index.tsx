// The plugin's own stylesheet rides the module graph: Vite injects it in
// dev; the lib build emits it as the bundle's index.css for the host to link.
import "./styles.css";
import type { KeepDeckPlugin } from "@keepdeck/plugin-api";
import { setRuntime } from "./runtime";
import { GitTab } from "./components/GitTab";
import { GitDiffOverlay } from "./components/GitDiffOverlay";

/** The Git built-in plugin: one dock tab with a live changes view per
 * worktree, on the plugin API's git service. */
const activate: KeepDeckPlugin["activate"] = (ctx) => {
  setRuntime(ctx);
  ctx.ui.registerDockTab({ id: "git", label: "Git", Component: GitTab });
  // The diff is a RESIDENT overlay, not part of the tab: a full-window peek
  // outlives the panel it was opened from, so switching dock tabs must not
  // hide it and closing the dock must not destroy it. Registered
  // unconditionally — it renders nothing until a diff is opened.
  ctx.ui.registerOverlay({ id: "diff", Component: GitDiffOverlay });
};

const deactivate = () => setRuntime(null);

export default { activate, deactivate } satisfies KeepDeckPlugin;
