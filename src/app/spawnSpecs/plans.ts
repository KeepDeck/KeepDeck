/**
 * What a pane's PTY spawn needs beyond the pane itself, and the per-install
 * constants it is built against.
 *
 * Application shapes, deliberately here and not in the domain. A plan is
 * argv, environment and two process credentials; the context is a bridge
 * inbox path; the protocol version mirrors a constant in the Rust bridge.
 * Every one of those changes when a MECHANISM changes — a CLI's flags, the
 * bridge's envelope — never when a product rule does, and no domain module
 * consumes any of them. (They were in `domain/agents` because they are plain
 * data with no imports; purity is not what makes something domain.)
 *
 * `ResumeOrigin` stays behind in the domain, and belongs there: WHO asked for
 * a resume decides whether a session that refuses may silently become a
 * different conversation, which is a product rule that survives replacing the
 * UI with a CLI.
 */
import type { ResumeOrigin } from "../../domain/agents";

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

/** What a pane's PTY spawn needs beyond the pane itself. */
export interface SpawnPlan {
  /** Program to run — the hook's word (prefilled with the detected binary;
   * `null` = the user's shell). Absent only on degraded bare plans. */
  command?: string | null;
  args: string[];
  env: [string, string][];
  /** Env pairs applied only when the key is NOT already inherited — a
   * user-owned variable beats a plugin's default (see SpawnPlanOutput). */
  envDefaults?: [string, string][];
  /** The PER-PANE bridge secret — NOT per build. A reporter must echo it in
   * its postback; the binding hook refuses postbacks whose token doesn't
   * match — writing a file into the inbox is not enough to bind a pane.
   *
   * INVARIANT: rebuilding a plan for a pane whose process is still alive
   * must REUSE the cached token (`buildPlan` does; any new plan-building
   * path must too) — a fresh mint would orphan the token the live process's
   * reporters echo, and every postback would fail verification forever.
   * Only an explicit restart, which drops the spec first, mints fresh. */
  token?: string;
  /** The PER-PANE MCP secret, minted and retired exactly like `token`: a
   * connection that announces it proves which pane's agent it belongs to, so
   * the journal names the actor. Kept SEPARATE from the bridge token — the
   * two authorize different things, and a leak of one must not widen the
   * other. Absent when nothing was injected for this pane.
   *
   * The slot `pane-3` is reused after a restart, which is exactly why the
   * secret exists: it dies with the process, so a lingering MCP child of a
   * dead pane resolves to nobody instead of to whoever holds the slot now.
   *
   * Minted for EVERY plan, whether or not anything was injected: kimi's
   * servers arrive as a file, so a pane can have a live client and no `mcp`
   * key here. Optional only because plans built before this existed have
   * none — it never answers "was MCP injected for this pane?". */
  mcpToken?: string;
  /** Host bookkeeping: the recorded session this plan tries to RESUME. Set
   * only on resume plans — the resume-failure detector keys off it. */
  resumeOf?: string;
  /** Host bookkeeping: the source session cloned by a FORK plan. */
  forkOf?: string;
  /** The first accepted local session binding emitted by that fork. Keeping
   * the derived id here prevents later `/new` sessions in the same process
   * from inheriting the fork's baseline-only treatment. */
  forkSessionId?: string;
  /** Host bookkeeping: who requested this resume. The origin determines
   * whether a silent refusal is eligible for the one-shot fresh fallback. */
  resumeOrigin?: ResumeOrigin;
  /** Host bookkeeping: the pane's accepted-postback count when this plan
   * was built. An exit with the count still here means the resume never
   * became a session (see `resumeDiedSilently`). */
  postbackMark?: number;
}
