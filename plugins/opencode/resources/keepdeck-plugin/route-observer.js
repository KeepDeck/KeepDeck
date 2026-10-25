/**
 * KeepDeck's opencode 1.x TUI plugin: it tells the server half which session
 * the user is looking at (foreground.js says why the server cannot tell).
 *
 * Loaded through `tui-v1.json` beside it, which the launch hands opencode as
 * `OPENCODE_TUI_CONFIG` (src/launch.ts) — on top of the user's own TUI
 * config, never instead of it. A module of its own: opencode 1.19.3 refuses
 * a module whose default carries both `server` and `tui`
 * (plugin/shared.ts:272-303), and index.js is the server half.
 *
 * It only reads the route (`api.route.current`, measured on 1.19.3) and
 * hands it to the shared watch (`observeRoute`, foreground.js). It never
 * navigates, never touches the composer.
 */
import { readBridge } from "./keepdeck-bridge.js";
import { observeRoute } from "./foreground.js";

/** A 1.x route as the server half reads it. */
export const routeOf = (current) => {
  if (current?.name === "session" && typeof current.params?.sessionID === "string") {
    return { route: "session", sessionID: current.params.sessionID };
  }
  if (current?.name === "home") return { route: "home" };
  // A plugin's own screen, or anything newer than this file: no session is
  // on screen, and it is not the home screen either.
  return { route: "other" };
};

export default {
  id: "keepdeck-route",
  tui: async (api) => {
    const bridge = readBridge();
    if (!bridge) return; // not a KeepDeck pane — stay inert
    const stop = observeRoute(() => routeOf(api.route.current), bridge.dir);
    api.lifecycle?.onDispose?.(stop);
  },
};
