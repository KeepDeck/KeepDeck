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
 * Every 2.x pane runs with `--standalone`, so this process serves one pane.
 */
import { startComponents } from "./components.js";
import { readBridge } from "./keepdeck-bridge.js";
import { startCourierV2 } from "./mail-courier-v2.js";
import { paneSession } from "./pane-session.js";
import { startReporterV2 } from "./session-reporter-v2.js";

/** Whether `context` is a 2.x host's: the domains this plugin uses. */
export function isV2Context(context) {
  return (
    typeof context?.event?.subscribe === "function" &&
    typeof context?.session?.get === "function"
  );
}

/**
 * Ask a 2.x server whether a session has a parent: `{ parentID }`, or null
 * when it could not tell. The 2.x client throws on a failed call, which the
 * pane session treats as "could not tell" too.
 */
export const parentLookupV2 = (context) => async (sessionID) => {
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
 * Start both components on a 2.x host, and feed them the bus.
 *
 * Inert outside a KeepDeck pane. A component that fails to start, or whose
 * handler throws, takes nothing else down — the same isolation index.js gives
 * the 1.x components.
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
  const components = (
    await startComponents([startReporterV2, startCourierV2], { context, bridge, pane, resumed })
  ).filter((component) => typeof component.onEvent === "function");
  // Not awaited: the bus runs for the life of the process, and `setup` must
  // return for opencode to finish loading.
  void feed(context, components);
}

/** Hand every bus event to every component, each through its own handler. */
async function feed(context, components) {
  try {
    for await (const event of context.event.subscribe()) {
      for (const component of components) {
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
}
