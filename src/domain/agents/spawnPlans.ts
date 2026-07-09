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
 * the CLI bridge. Resume rides the same builder so per-agent flag order stays
 * in one place. Pure: context in, plan out.
 */

/** Bridge protocol version this app speaks — mirrors `BRIDGE_PROTOCOL_VERSION`
 * in src-tauri/src/bridge.rs (a plain change counter over the env schema AND
 * the envelope schema). */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Per-install constants, resolved once at boot (`session_spawn_context`). */
export interface SpawnPlanContext {
  /** This run's bridge inbox — where reporters drop postbacks; "" = bridge
   * unavailable, identity mechanisms off. */
  bridgeDir: string;
  /** Ready-made claude `--settings` args arming the SessionStart hook —
   * how a mid-life `/clear` (a session swap) reaches KeepDeck. */
  claudeHookArgs: string[] | null;
  /** Ready-made codex `-c` args enabling the SessionStart hook (config +
   * trusted hash); null when unavailable (old codex, missing resource). */
  codexHookArgs: string[] | null;
  /** Absolute path of the opencode session-reporter plugin; null = missing. */
  opencodePluginPath: string | null;
}

/** A context with every identity mechanism off — safe boot fallback. */
export const EMPTY_SPAWN_CONTEXT: SpawnPlanContext = {
  bridgeDir: "",
  claudeHookArgs: null,
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
  /** The per-spawn bridge secret. A reporter must echo it in its postback;
   * the binding hook refuses postbacks whose token doesn't match — writing a
   * file into the inbox is not enough to bind a pane. Set only when a
   * reporter was actually armed. */
  token?: string;
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
    /** Mints a fresh session id (claude requires a lowercase UUID). Only a
     * fresh claude spawn consumes it, but the plan builder decides that —
     * the caller just brings the mint (see app/ids.ts). */
    mintId: () => string;
    /** Mints the per-spawn bridge token (see app/ids.ts). */
    mintToken: () => string;
  },
): SpawnPlan {
  // Reporters can only post back when the bridge exists. The single
  // KEEPDECK_BRIDGE env var carries everything a reporter needs — protocol
  // version, inbox dir, pane correlation, and the anti-forgery token — and
  // is only armed for a spawn that actually carries a reporter (it's inert
  // otherwise, so don't leak it).
  const token = ctx.bridgeDir ? opts.mintToken() : null;
  const bridgeEnv: [string, string][] = token
    ? [
        [
          "KEEPDECK_BRIDGE",
          JSON.stringify({
            v: BRIDGE_PROTOCOL_VERSION,
            dir: ctx.bridgeDir,
            pane: paneId,
            token,
          }),
        ],
      ]
    : [];
  const armed = (env: [string, string][]) =>
    env.length > 0 && token ? { env, token } : { env: [] as [string, string][] };
  // The resume recipe: prefer the catalog's, but a catalog entry WITHOUT one
  // (plugin contributions don't carry resume flags yet) falls through to the
  // static recipe — a known agent must never lose resume to a sparse entry.
  const info = opts.agents?.find((a) => a.id === agentType);
  const recipe = info?.resumePrefix?.length
    ? info
    : FALLBACK_AGENTS.find((a) => a.id === agentType);
  const resume = opts.resumeId ? resumeArgs(recipe, opts.resumeId) : null;

  switch (agentType) {
    case "claude": {
      // The id is ASSIGNED for a fresh spawn (no discovery, ever) and REUSED
      // on resume (forking is opt-in). The SessionStart hook rides along as
      // the reporter for mid-life session swaps — /clear and compaction
      // change the session id underneath an otherwise-silent pane.
      const hook = ctx.claudeHookArgs ?? [];
      const arm = armed(hook.length > 0 ? bridgeEnv : []);
      if (resume) return { args: [...hook, ...resume], ...arm };
      const id = opts.mintId();
      return { args: [...hook, "--session-id", id], sessionId: id, ...arm };
    }
    case "codex": {
      // The `-c` hook overrides are global flags — they must precede the
      // `resume` subcommand.
      const hook = ctx.codexHookArgs ?? [];
      return {
        args: [...hook, ...(resume ?? [])],
        ...armed(hook.length > 0 ? bridgeEnv : []),
      };
    }
    case "opencode": {
      if (!ctx.opencodePluginPath || bridgeEnv.length === 0) {
        return { args: resume ?? [], env: [] };
      }
      return {
        args: resume ?? [],
        ...armed([
          ...bridgeEnv,
          [
            "OPENCODE_CONFIG_CONTENT",
            // Merged into the user's config by opencode; the array form is
            // additive (plugin origins concatenate), nothing is replaced.
            JSON.stringify({ plugin: [ctx.opencodePluginPath] }),
          ],
        ]),
      };
    }
    default:
      // An agent this builder doesn't know (the id set is open): a bare
      // spawn, no identity mechanism — the spawn/resume hooks take over
      // per-agent planning in a later stage.
      return { args: resume ?? [], env: [] };
  }
}
