/**
 * KeepDeck's opencode plugin — the one entry opencode loads.
 *
 * KeepDeck injects this DIRECTORY per spawn, as `plugin: [<this dir>]` in
 * `OPENCODE_CONFIG_CONTENT`, and both opencode generations find this file in
 * it (measured on 1.19.3 and 2.1.2, task-425):
 *
 *   1.x  reads `default.server` — the `(input, options) => hooks` function —
 *        and ignores every other key
 *   2.x  reads `default.setup(context)` and strips `server`; it refuses a
 *        plugin given as a FILE path, which is why this is a directory.
 *        Its adapter is opencode-v2.js
 *
 * ONE ENTRY, TWO COMPONENTS. The reporter and the courier stay separate
 * modules for the reasons in their headers, but they must not be two plugin
 * entries: they agree on the pane's conversation through ONE `pane-session.js`
 * and state facts through ONE wire (`keepdeck-bridge.js`), and opencode 2.x
 * gives each plugin entry its own copy of a sibling module. Loaded from here,
 * there is one module graph and one copy, on either generation.
 *
 * What being two plugins used to give for free is kept here instead: a
 * component that fails to start, or whose handler throws, takes nothing else
 * down — both are best-effort, and a KeepDeck problem must never break the
 * user's session.
 */
import { startCourier } from "./mail-courier.js";
import { startComponents } from "./components.js";
import { follower } from "./follower.js";
import { setupV2 } from "./opencode-v2.js";
import { startReporter } from "./session-reporter.js";

/**
 * One hook map out of several. Every handler of a name is called with the
 * same arguments, all of them before any is waited on — opencode 1.x fires
 * `event` at each plugin without waiting, and one component's slow handler
 * must not hold the other's back. A handler that throws or rejects is
 * silenced alone.
 */
export function composeHooks(maps) {
  const names = new Set(maps.flatMap((map) => Object.keys(map)));
  return Object.fromEntries(
    [...names].map((name) => {
      const handlers = maps.map((map) => map[name]).filter((fn) => typeof fn === "function");
      const hook = (...args) =>
        Promise.all(
          handlers.map((handler) => {
            try {
              return Promise.resolve(handler(...args)).catch(() => {});
            } catch {
              return undefined;
            }
          }),
        ).then(() => {});
      return [name, hook];
    }),
  );
}

export default {
  id: "keepdeck",
  /** opencode 1.x. */
  server: async (input) => {
    const hooks = composeHooks(await startComponents([startReporter, startCourier], input));
    // Both components have joined the follower by now (follower.js).
    follower().start();
    return hooks;
  },
  /** opencode 2.x (opencode-v2.js). */
  setup: (context) => setupV2(context),
};
