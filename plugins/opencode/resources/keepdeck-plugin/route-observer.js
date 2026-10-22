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
 * writes it down. It never navigates, never touches the composer.
 *
 * A route is written once it held for two polls in a row, so a screen the
 * TUI only passes through is not reported as somewhere the user went.
 */
import { readBridge } from "./keepdeck-bridge.js";
import { HEARTBEAT_MS, writeForeground } from "./foreground.js";

export const POLL_MS = 250;

/** The route as the server half reads it. */
export const routeOf = (current) => {
  if (current?.name === "session" && typeof current.params?.sessionID === "string") {
    return { route: "session", sessionID: current.params.sessionID };
  }
  if (current?.name === "home") return { route: "home" };
  // A plugin's own screen, or anything newer than this file: no session is
  // on screen, and it is not the home screen either.
  return { route: "other" };
};

const same = (a, b) => a?.route === b?.route && a?.sessionID === b?.sessionID;

/** Start watching `api`'s route; returns the stop. Exported for its tests. */
export function observeRoute(api, dir, now = () => Date.now()) {
  let seen; // the last route read
  let held; // the route last written
  let writtenAt = 0;
  const poll = () => {
    let route;
    try {
      route = routeOf(api.route.current);
    } catch {
      return;
    }
    const steady = same(route, seen);
    seen = route;
    const changed = steady && !same(route, held);
    if (!changed && (held === undefined || now() - writtenAt < HEARTBEAT_MS)) return;
    if (changed) held = route;
    try {
      writtenAt = now();
      writeForeground(dir, held, writtenAt);
    } catch {
      // Best-effort: a pane whose route cannot be written behaves as before.
    }
  };
  const timer = setInterval(poll, POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export default {
  id: "keepdeck-route",
  tui: async (api) => {
    const bridge = readBridge();
    if (!bridge) return; // not a KeepDeck pane — stay inert
    const stop = observeRoute(api, bridge.dir);
    api.lifecycle?.onDispose?.(stop);
  },
};
