// The plugin's own stylesheet rides the module graph: Vite injects it in
// dev; the lib build emits it as the bundle's index.css for the host to link.
import "./styles.css";
import type { KeepDeckPlugin } from "@keepdeck/plugin-api";
import { setRuntime } from "./runtime";
import { takePeekRequest } from "./peekRequests";
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

const deactivate = () => {
  // Drain the one-slot bus: a request parked in this lifetime must never
  // replay into the NEXT activation's overlay as a stale peek.
  takePeekRequest();
  setRuntime(null);
  // Status feeds are deliberately NOT closed here. A feed belongs to its
  // subscribers, and they are still mounted at this point — the host runs
  // `deactivate` before it disposes the contributions that unmount them. It
  // closed feeds out from under live surfaces, which rewound their `version`
  // to the unknown-repo default and re-ran every read keyed on it against a
  // runtime this line has just nulled. The last surface to unmount closes
  // the feed and disposes its watch, which is the same teardown by a route
  // that cannot run early.
};

export default { activate, deactivate } satisfies KeepDeckPlugin;
