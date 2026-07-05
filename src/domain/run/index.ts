/**
 * Run — the experimental run-presets feature: what executing a preset means
 * (the env contract, preset editing), run-session lifecycle for the Run
 * panel, and the feature's availability criteria. The stored per-workspace
 * shape lives with the deck document (deck/workspaceRun.ts); this package
 * builds the feature on top of it.
 */
export * from "./criteria";
export * from "./presets";
export * from "./sessions";
