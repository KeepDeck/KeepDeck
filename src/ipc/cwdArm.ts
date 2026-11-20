import { invoke } from "@tauri-apps/api/core";
import { errorMessage, type CwdArm } from "@keepdeck/plugin-api";
import { log } from "./log";

/**
 * Planting what an agent's plugin declares in a pane's cwd (`cwd_arm/`):
 * the native side owns everything that makes it safe — the proof of what is
 * its own, link scope, the git exclude, the per-workspace record. Taking it
 * back is the lifecycle's, natively.
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
