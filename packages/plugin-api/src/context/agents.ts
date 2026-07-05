import type { Disposable } from "./disposable.ts";

/**
 * Agent contributions — teaching KeepDeck a CLI agent. Static identity is
 * data; the CLI-specific logic lives in hooks the host calls at lifecycle
 * points, with serializable input/output mutated in place (the opencode
 * model). Serializable I/O is what lets the same hook run in-process or
 * across the external tier's RPC boundary.
 */
export interface PluginAgents {
  register(agent: AgentContribution): Disposable;
}

export interface AgentContribution {
  id: string;
  label: string;
  /** How to find the CLI on this machine. */
  detect: { bin: string };
  hooks: AgentHooks;
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
  /** Pre-minted session identity the host expects the CLI to adopt. */
  sessionId: string;
  /** Where the session reporter posts binding events. */
  spoolPath: string;
}

export interface ResumePlanInput {
  paneId: string;
  wsId: string;
  cwd: string;
  /** The recorded session to resume. */
  sessionId: string;
  spoolPath: string;
}

/** Mutate-in-place spawn plan: hooks adjust what the host will run. */
export interface SpawnPlanOutput {
  /** Program to run; `null` = the user's shell. */
  command: string | null;
  args: string[];
  env: [string, string][];
}
