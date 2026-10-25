// @ts-check
/**
 * KeepDeck's plugin on opencode 2.x — the `setup(context)` half of index.js.
 *
 * opencode 2.x hands a plugin domains instead of a client and a hook map
 * (packages/plugin/src/promise/plugin.ts at v2.1.2): `event.subscribe()` for
 * the bus, `session` for asking and writing, `session.hook` / `tool.hook` for
 * the moments a message can ride along. This file is the adapter between
 * those and the two components (session-reporter-v2.js, mail-courier-v2.js);
 * what the components share with 1.x — the pane's session, the wire, the mail
 * ask, the doorbell — they import as 1.x does.
 *
 * Every 2.x pane runs with `--standalone`, so this process serves one pane:
 * the TUI spawns it as `opencode serve`, and that TUI is its parent process
 * — whose screen the follower reads (tui.js writes it; task-436).
 */
import { startComponents } from "./components.js";
import { follower } from "./follower.js";
import { readBridge } from "./keepdeck-bridge.js";
import { startCourierV2 } from "./mail-courier-v2.js";
import { paneSession } from "./pane-session.js";
import { startReporterV2 } from "./session-reporter-v2.js";

/** @typedef {{ event: { subscribe: () => AsyncIterable<unknown> }, session: { get: (query: { sessionID: string }) => Promise<{ id?: string, parentID?: string }> } }} V2Context */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null;

/** Whether `context` is a 2.x host's: the domains this plugin uses.
 * @param {unknown} context
 * @returns {context is V2Context}
 */
export function isV2Context(context) {
  return (
    isRecord(context) && isRecord(context.event) && typeof context.event.subscribe === "function" &&
    isRecord(context.session) && typeof context.session.get === "function"
  );
}

/**
 * Ask a 2.x server whether a session has a parent: `{ parentID }`, or null
 * when it could not tell. The 2.x client throws on a failed call, which the
 * pane session treats as "could not tell" too.
 * @param {V2Context} context
 */
export const parentLookupV2 = (context) => async (/** @type {string} */ sessionID) => {
  const found = await context.session.get({ sessionID });
  if (!found?.id) return null;
  return { parentID: found.parentID };
};

/** The session KeepDeck resumed this pane in, when it did. The launch names
 * it twice — `-s` for the TUI, this for us: under `--standalone` this plugin
 * runs in the child `opencode serve`, whose arguments carry no `-s`, while
 * the environment passes through (task-382, measured). Mirrors
 * OPENCODE_SESSION_ENV in plugins/opencode/src/launch.ts. */
export const resumedSession = () => process.env.KEEPDECK_OPENCODE_SESSION || undefined;

/**
 * Start both components on a 2.x host, feed them the bus, and follow the
 * TUI's screen. Returns the cleanup opencode 2.x calls when it reloads or
 * unloads the plugin: a reload starts everything afresh, and what the old
 * one left running — the bus, the doorbell, the screen watch — would answer
 * twice.
 *
 * Inert outside a KeepDeck pane. A component that fails to start, or whose
 * handler throws, takes nothing else down — the same isolation index.js gives
 * the 1.x components.
 * @param {unknown} context
 */
export async function setupV2(context) {
  if (!isV2Context(context)) return;
  const bridge = readBridge();
  if (!bridge) return;
  const pane = paneSession(parentLookupV2(context));
  // Bound before anything starts: a resumed session says nothing until it
  // works, and a ring already waiting on disk would otherwise find the pane
  // with no conversation to deliver into. KeepDeck resumes a pane's ROOT, so
  // no lookup is needed — and none is made while opencode is still loading.
  const resumed = resumedSession();
  if (resumed) pane.bindFromChain(resumed);
  const components = await startComponents([startReporterV2, startCourierV2], {
    context,
    bridge,
    pane,
    resumed,
  });
  // Both components have joined the follower by now (follower.js).
  const stopFollowing = follower().start(bridge.dir, process.ppid);
  const stopFeed = feed(
    context,
    components.filter(isRecord).filter((component) => typeof component.onEvent === "function"),
  );
  return () => {
    stopFollowing();
    stopFeed();
    for (const component of components) {
      if (!isRecord(component) || typeof component.stop !== "function") continue;
      try {
        component.stop();
      } catch {
        // Stopping one is not stopping the other.
      }
    }
  };
}

/**
 * Hand every bus event to every component, each through its own handler.
 * Returns the stop. Not awaited: the bus runs for the life of the plugin, and
 * `setup` must return for opencode to finish loading.
 * @param {V2Context} context
 * @param {Array<Record<string, unknown>>} components
 */
function feed(context, components) {
  /** @type {AsyncIterator<unknown> | undefined} */
  let iterator;
  // A generator mid-`next()` finishes that wait before it returns: what
  // arrives meanwhile is not handed on.
  let stopped = false;
  void (async () => {
    try {
      iterator = context.event.subscribe()[Symbol.asyncIterator]();
      for (;;) {
        const { value: event, done } = await iterator.next();
        if (done || stopped) return;
        for (const component of components) {
          if (typeof component.onEvent !== "function") continue;
          try {
            component.onEvent(event);
          } catch {
            // One component's mistake is not the other's.
          }
        }
      }
    } catch {
      // The bus closed — the process is going. Nothing to report it to.
    }
  })();
  return () => {
    stopped = true;
    void iterator?.return?.()?.catch?.(() => {});
  };
}
