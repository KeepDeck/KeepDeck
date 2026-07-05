/**
 * @keepdeck/plugin-api — the contract KeepDeck plugins build against.
 *
 * Two halves: `manifest/` is the static side (identity, capabilities, API
 * floor — validated before any plugin code runs); `context/` is the runtime
 * side (the `PluginContext` handed to `activate`, one module per concern).
 *
 * Plugins bundle with this package (and react) marked EXTERNAL; at runtime
 * the host's import map resolves both to the host's own copies, so a plugin
 * component shares the host React instance. The contract is deliberately
 * transport-agnostic: the built-in tier calls it in-process, the external
 * tier speaks it over postMessage RPC.
 */
export * from "./manifest/index.ts";
export * from "./context/index.ts";
