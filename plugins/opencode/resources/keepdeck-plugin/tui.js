// @ts-check
/**
 * KeepDeck's opencode 2.x TUI plugin — the 2.x twin of route-observer.js.
 *
 * opencode 2.x finds it by itself: a local plugin directory with a `tui`
 * entry is loaded into the TUI process (packages/plugin/src/host.ts at
 * v2.1.2), so the launch needs no TUI config. opencode 1.x never loads it —
 * its TUI plugins come from the TUI config alone (task-436, read in the
 * 1.19.3 source and measured).
 *
 * Two jobs, both through the pane's bridge directory:
 * - the screen: `ui.router.current()` → foreground.json, through the shared
 *   watch (`observeRoute`). The server half runs in a child process
 *   (`opencode serve`), and reads it as its parent's.
 * - showing a session the courier made for mail (show-request.js) — but
 *   only while the user is on the home screen, where that session is what
 *   they would have opened next. Anywhere else the request is dropped.
 *
 * Inert outside a KeepDeck pane, and it never throws: a TUI plugin that
 * fails is a toast in the user's session (task-448).
 */
import { readBridge } from "./keepdeck-bridge.js";
import { POLL_MS, observeRoute } from "./foreground.js";
import { takeShowRequest } from "./show-request.js";

/** A 2.x route as the server half reads it.
 * @param {unknown} current
 */
export const routeOfV2 = (current) => {
  if (!current || typeof current !== "object") return { route: "other" };
  const route = /** @type {{ type?: string, sessionID?: string }} */ (current);
  if (route.type === "session" && typeof route.sessionID === "string" && route.sessionID) {
    return { route: "session", sessionID: route.sessionID };
  }
  if (route.type === "home") return { route: "home" };
  // A plugin's own page, or anything newer than this file: no session is on
  // screen, and it is not the home screen either.
  return { route: "other" };
};

/** Show what the courier asked for, while the home screen is up. Returns the
 * stop.
 * @param {{ current: () => unknown, navigate?: (route: { type: string, sessionID: string }) => unknown }} router
 * @param {string} dir
 */
export function obeyShowRequests(router, dir) {
  const timer = setInterval(() => {
    try {
      const sessionID = takeShowRequest(dir);
      const current = router.current();
      if (!sessionID || !current || typeof current !== "object" || !("type" in current) || current.type !== "home") return;
      router.navigate?.({ type: "session", sessionID });
    } catch {
      // Best-effort: a request not obeyed costs one empty session, and the
      // courier tries no more until the screen changes.
    }
  }, POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export default {
  id: "keepdeck-screen",
  /** @param {{ ui?: { router?: { current: () => unknown, navigate?: (route: { type: string, sessionID: string }) => unknown } } } | undefined} context */
  setup(context) {
    try {
      const bridge = readBridge();
      const router = context?.ui?.router;
      if (!bridge || typeof router?.current !== "function") return undefined;
      const stopRoute = observeRoute(() => routeOfV2(router.current()), bridge.dir);
      const stopShow = obeyShowRequests(router, bridge.dir);
      // opencode 2.x calls this on reload and shutdown: a reloaded plugin
      // must not leave the old watch writing beside the new one.
      return () => {
        stopRoute();
        stopShow();
      };
    } catch {
      return undefined;
    }
  },
};
