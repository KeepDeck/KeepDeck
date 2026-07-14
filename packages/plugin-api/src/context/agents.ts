import type { Disposable } from "./disposable.ts";

/**
 * Agent contributions — teaching KeepDeck a CLI agent. Static identity is
 * data; the CLI-specific logic lives in hooks the host calls at lifecycle
 * points, with serializable input/output mutated in place (the opencode
 * model). Serializable I/O is what lets the same hook run in-process or
 * across the external tier's RPC boundary.
 *
 * FORWARD SURFACE: declared ahead of a consumer on purpose — the CLI agents
 * (claude/codex/opencode) migrate onto this in a later stage. Until then the
 * host's own spawnSpecs/domain/agents is the live spawn path; when the
 * migration lands, reconcile this contract against that mechanism so the two
 * spawn models don't drift.
 */
export interface PluginAgents {
  register(agent: AgentContribution): Disposable;
}

export interface AgentContribution {
  id: string;
  label: string;
  /** The agent's brand mark, shown wherever the host names the agent. */
  icon?: AgentIcon;
  /** How to find the CLI on this machine. */
  detect: { bin: string };
  hooks: AgentHooks;
}

/** A brand mark as bare SVG path data — data, never markup, so a plugin
 * cannot inject live SVG/HTML into the host chrome, and the icon crosses the
 * external tier's RPC boundary as plain JSON. */
export interface AgentIcon {
  /** Coordinate space the path is drawn in, e.g. `"0 0 24 24"`. */
  viewBox: string;
  /** Path data; multiple subpaths are filled as one shape. */
  path: string;
  /** Brand tint; omit to inherit the surrounding text color (adapts to theme). */
  color?: string;
  /** Fill rule the artwork was authored for; omit for SVG's default nonzero. */
  fillRule?: "evenodd";
}

export interface AgentHooks {
  /** Fill in how THIS CLI spawns for a pane: args, env, config injection. */
  "spawn.plan"?(
    input: SpawnPlanInput,
    output: SpawnPlanOutput,
  ): void | Promise<void>;
  /** Fill in how to resume a recorded session in a revived pane. */
  "resume.plan"?(
    input: ResumePlanInput,
    output: SpawnPlanOutput,
  ): void | Promise<void>;
}

export interface SpawnPlanInput {
  paneId: string;
  wsId: string;
  cwd: string;
  branch?: string;
}

export interface ResumePlanInput {
  paneId: string;
  wsId: string;
  cwd: string;
  branch?: string;
  /** The recorded session to resume. */
  sessionId: string;
}

/** Mutate-in-place spawn plan: hooks adjust what the host will run. */
export interface SpawnPlanOutput {
  /** Program to run; `null` = the user's shell. */
  command: string | null;
  args: string[];
  env: [string, string][];
}
