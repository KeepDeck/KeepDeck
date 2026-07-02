import {
  FALLBACK_AGENTS,
  resumeArgs,
  type AgentInfo,
  type AgentType,
} from "./agents";

/**
 * Spawn plans — session identity v2 ([F7]/[F8]).
 *
 * One builder decides, per agent, how a pane's PTY spawn carries its session
 * identity: claude gets the id ASSIGNED (`--session-id`, minted here); codex
 * and opencode get a REPORTER armed (hook / plugin shipped with KeepDeck,
 * activated purely via this spawn's argv+env) that posts the id back through
 * the spool. Resume rides the same builder so per-agent flag order stays in
 * one place. Pure: context in, plan out.
 */

/** Per-install constants, resolved once at boot (`session_spawn_context`). */
export interface SpawnPlanContext {
  /** Where reporters drop postbacks (`KEEPDECK_SPOOL`); "" = unavailable. */
  spoolDir: string;
  /** Ready-made codex `-c` args enabling the SessionStart hook (config +
   * trusted hash); null when unavailable (old codex, missing resource). */
  codexHookArgs: string[] | null;
  /** Absolute path of the opencode session-reporter plugin; null = missing. */
  opencodePluginPath: string | null;
}

/** A context with every identity mechanism off — safe boot fallback. */
export const EMPTY_SPAWN_CONTEXT: SpawnPlanContext = {
  spoolDir: "",
  codexHookArgs: null,
  opencodePluginPath: null,
};

/** What a pane's PTY spawn needs beyond the command. */
export interface SpawnPlan {
  args: string[];
  env: [string, string][];
  /** The session id KeepDeck assigned at spawn (claude) — bind immediately,
   * no discovery. */
  sessionId?: string;
}

export function buildSpawnPlan(
  agentType: AgentType,
  paneId: string,
  ctx: SpawnPlanContext,
  opts: {
    /** Resume this recorded session instead of starting fresh. */
    resumeId?: string | null;
    /** Catalog for resume prefixes; falls back to the static recipes. */
    agents?: AgentInfo[];
    /** Injected for tests; defaults to crypto.randomUUID (lowercase). */
    mintId?: () => string;
  } = {},
): SpawnPlan {
  // Reporters can only post back when the spool exists.
  const reporterEnv: [string, string][] = ctx.spoolDir
    ? [
        ["KEEPDECK_PANE_ID", paneId],
        ["KEEPDECK_SPOOL", ctx.spoolDir],
      ]
    : [];
  const info =
    opts.agents?.find((a) => a.id === agentType) ??
    FALLBACK_AGENTS.find((a) => a.id === agentType);
  const resume = opts.resumeId ? resumeArgs(info, opts.resumeId) : null;

  switch (agentType) {
    case "claude": {
      // Resume REUSES the assigned id (forking is opt-in), so a resumed pane
      // needs no new identity; a fresh one gets its id before the process
      // even starts — no discovery, ever.
      if (resume) return { args: resume, env: [] };
      const id = (opts.mintId ?? mintUuid)();
      return { args: ["--session-id", id], env: [], sessionId: id };
    }
    case "codex": {
      // The `-c` hook overrides are global flags — they must precede the
      // `resume` subcommand.
      const hook = ctx.codexHookArgs ?? [];
      return {
        args: [...hook, ...(resume ?? [])],
        env: hook.length > 0 ? reporterEnv : [],
      };
    }
    case "opencode": {
      if (!ctx.opencodePluginPath || reporterEnv.length === 0) {
        return { args: resume ?? [], env: [] };
      }
      return {
        args: resume ?? [],
        env: [
          ...reporterEnv,
          [
            "OPENCODE_CONFIG_CONTENT",
            // Merged into the user's config by opencode; the array form is
            // additive (plugin origins concatenate), nothing is replaced.
            JSON.stringify({ plugin: [ctx.opencodePluginPath] }),
          ],
        ],
      };
    }
  }
}

function mintUuid(): string {
  return crypto.randomUUID();
}
