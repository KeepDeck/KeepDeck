/**
 * `@keepdeck/plugin-guest` — the runtime an external KeepDeck plugin's logic
 * bundle links against. It turns the host's postMessage RPC bridge back into the
 * ordinary `PluginContext` the plugin's `activate` expects, so a plugin's code
 * is IDENTICAL whether it runs built-in (in-process) or external (sandboxed):
 * only the runtime it calls at startup differs.
 *
 * The wire protocol is re-exported from its single source of truth in the host,
 * so tooling and tests on the plugin side share the exact same message shapes
 * the host uses.
 */
export { connectPluginGuest } from "./connect";
export * from "./protocol";
