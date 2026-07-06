/**
 * Run — the plugin's own domain: what executing a preset means (the env
 * contract, the preset-list edits) and the run-session model behind the panel
 * (statuses, the merged command rows, spawn options). Everything here is pure
 * and testable without the plugin context; the manager and components wire it
 * to `ctx.services` and `ctx.storage`.
 */
export * from "./presets";
export * from "./sessions";
