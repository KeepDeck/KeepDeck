import type { Disposable } from "./disposable.ts";
import type { WorkspaceRef } from "./snapshots.ts";

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
  /** Whether this CLI can run with its permission prompts disabled (YOLO
   * mode). Declares the capability only — the host gates its YOLO toggle on
   * it; the hooks are where `input.yolo` becomes the CLI's actual flag. */
  supportsYolo?: boolean;
  hooks: AgentHooks;
}

/** A brand mark as bare SVG path data — data, never markup, so a plugin
 * cannot inject live SVG/HTML into the host chrome, and the icon crosses the
 * external tier's RPC boundary as plain JSON. Multi-tone artwork (e.g. the
 * official OpenCode frame + block cursor) is a stack of layers. */
export interface AgentIcon {
  /** Coordinate space every layer is drawn in, e.g. `"0 0 24 24"`. */
  viewBox: string;
  /** Filled shapes, painted in order; single-color marks are one layer. */
  paths: AgentIconPath[];
}

/** One filled layer of a brand mark. */
export interface AgentIconPath {
  /** Path data; multiple subpaths are filled as one shape. */
  d: string;
  /** This layer's fill; omit to inherit the surrounding text color. */
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
  workspace: WorkspaceRef;
  cwd: string;
  branch?: string;
  /** The pane runs with permission prompts disabled: a supporting hook adds
   * its CLI's skip-permissions flag. Absent on hosts older than API 20. */
  yolo?: boolean;
}

export interface ResumePlanInput extends SpawnPlanInput {
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
