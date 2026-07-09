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
  /** Pre-minted session identity. A CLI that can ADOPT an assigned id spawns
   * with it and echoes it in `SpawnPlanOutput.sessionId`; a CLI that mints
   * its own ignores it (its reporter posts the real id back later). The
   * bridge transport itself is host business — the host arms the reporter
   * env on every agent spawn; plugins never see the inbox. */
  sessionId: string;
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
  /** The id this spawn is KNOWN to run under — set it only when the CLI
   * adopted the assigned id (or resumes a recorded one); the host binds it
   * immediately, no discovery. `null` = the session id arrives later via
   * the reporter. */
  sessionId: string | null;
}
