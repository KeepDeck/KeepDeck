import { invoke } from "@tauri-apps/api/core";
import { errorMessage, type CwdArm } from "@keepdeck/plugin-api";
import { log } from "./log";

/**
 * Planting what an agent's plugin declares in a pane's cwd (`cwd_arm.rs`):
 * the native side owns everything that makes it safe — markers, link scope,
 * the git exclude, the per-workspace record a crash sweep reads.
 */

/** A path not planted, and why — words the app puts on screen. */
export interface CwdArmRefusal {
  path: string;
  reason: string;
}

export interface CwdArmReport {
  armed: string[];
  refused: CwdArmRefusal[];
}

/** One plugin's complete set for one cwd. */
export interface CwdArmRequest {
  pluginId: string;
  workspaceId: string;
  cwd: string;
  arms: readonly CwdArm[];
  /** The plan's `skills.dir`: a symlink may point into it. */
  skillsDir: string | null;
}

/** Plant one plugin's set in one cwd. A failed call refuses every path it was
 * asked about — never an empty report, which is what "nothing to do" looks
 * like and would hide a dead backend. */
export async function cwdArm(request: CwdArmRequest): Promise<CwdArmReport> {
  try {
    return await invoke<CwdArmReport>("cwd_arm", {
      pluginId: request.pluginId,
      wsId: request.workspaceId,
      cwd: request.cwd,
      arms: request.arms,
      skillsDir: request.skillsDir,
    });
  } catch (e) {
    const reason = errorMessage(e);
    log.warn("web:arming", `arming ${request.cwd} failed: ${reason}`);
    return { armed: [], refused: request.arms.map(({ path }) => ({ path, reason })) };
  }
}

/** Take back everything planted in these cwds, except in one a live workspace
 * still runs a pane in — the native side judges that, on real paths. Returns
 * the cwds released, or null when the pass did not get through: a sweep must
 * not record itself as done on a failed pass. */
export async function cwdDisarm(
  roots: readonly string[],
  liveRoots: readonly string[],
): Promise<string[] | null> {
  if (roots.length === 0) return [];
  try {
    return await invoke<string[]>("cwd_disarm", { roots, liveRoots });
  } catch (e) {
    log.warn("web:arming", `disarm failed: ${errorMessage(e)}`);
    return null;
  }
}

/** Sweep what workspaces that are gone planted. */
export async function cwdArmPrune(liveWsIds: readonly string[]): Promise<boolean> {
  try {
    await invoke("cwd_arm_prune", { liveWsIds });
    return true;
  } catch (e) {
    log.warn("web:arming", `prune failed: ${errorMessage(e)}`);
    return false;
  }
}
