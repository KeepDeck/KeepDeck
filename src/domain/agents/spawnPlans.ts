/**
 * Spawn-plan types (session identity v2, [F7]/[F8]). The per-agent planning
 * itself lives in the cli plugins' `spawn.plan`/`resume.plan` hooks; the
 * host builds plans through them in `app/spawnSpecs.ts` and arms the bridge
 * on top. These are the shared shapes.
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
}

/** A context with the bridge off — safe boot fallback. */
export const EMPTY_SPAWN_CONTEXT: SpawnPlanContext = {
  bridgeDir: "",
};

/** Why a resume plan was requested. Only boot restoration may fall back to
 * one automatic fresh spawn when the recorded session no longer exists;
 * user-requested resumes must leave the exited pane visible. */
export type ResumeOrigin = "restore" | "manual";

/** What a pane's PTY spawn needs beyond the pane itself. */
export interface SpawnPlan {
  /** Program to run — the hook's word (prefilled with the detected binary;
   * `null` = the user's shell). Absent only on degraded bare plans. */
  command?: string | null;
  args: string[];
  env: [string, string][];
  /** The per-spawn bridge secret. A reporter must echo it in its postback;
   * the binding hook refuses postbacks whose token doesn't match — writing a
   * file into the inbox is not enough to bind a pane. */
  token?: string;
  /** Host bookkeeping: the recorded session this plan tries to RESUME. Set
   * only on resume plans — the resume-failure detector keys off it. */
  resumeOf?: string;
  /** Host bookkeeping: who requested this resume. The origin determines
   * whether a silent refusal is eligible for the one-shot fresh fallback. */
  resumeOrigin?: ResumeOrigin;
  /** Host bookkeeping: the pane's accepted-postback count when this plan
   * was built. An exit with the count still here means the resume never
   * became a session (see `resumeDiedSilently`). */
  postbackMark?: number;
}
