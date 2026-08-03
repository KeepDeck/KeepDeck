/**
 * Agents — the coding-agent catalog and how a pane runs one: agent kinds and
 * detection info (mirroring the Rust catalog), worktree-location resolution
 * for placing an agent, spawn plans carrying session identity (argv/env), and
 * the rule for which reports may speak for a pane running one.
 */
export * from "./agentLocation";
export * from "./agents";
export * from "./features";
export * from "./sessionAttribution";
export * from "./spawnPlans";
