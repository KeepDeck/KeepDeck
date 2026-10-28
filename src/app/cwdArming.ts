/**
 * The arming path a spawn takes: plant what an agent's plugin declared in
 * the pane's cwd (through the worktree owner, which orders it against
 * teardown) and say what was refused, under the agent — one owner, so the
 * spawn paths only ask.
 */
import type { CwdArmAsk } from "./spawnSpecs";
import type { CwdArming } from "./worktrees";
import type { ArmRefusalStore } from "./armRefusals";
import { log } from "../ipc/log";

export function createCwdArming(deps: {
  worktrees: CwdArming;
  refusals: Pick<ArmRefusalStore, "record">;
}): CwdArmAsk {
  return async (agentId, request) => {
    const report = await deps.worktrees.armCwd(request);
    for (const { path, reason } of report.refused) {
      log.warn("web:arming", `${agentId}: ${request.cwd}/${path} not planted: ${reason}`);
    }
    deps.refusals.record(agentId, request.cwd, report.refused);
  };
}
