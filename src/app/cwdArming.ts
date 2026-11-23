/**
 * The arming path a spawn takes: plant what an agent's plugin declared in
 * the pane's cwd, and say what was refused, under the agent — one owner, so
 * the spawn paths only ask.
 *
 * A folder is planted in only under the machine's arm lease: while the
 * lease is held, nothing the lifecycle runs removes or takes back that
 * folder, and a folder already on its way out is refused the lease. The
 * lease goes the moment the planting is done.
 */
import type { CwdArmAsk } from "./spawnSpecs";
import type { CwdArming } from "./worktrees";
import type { ArmRefusalStore } from "./armRefusals";
import type { LeaseAsk } from "../ipc/generated/lifecycle/LeaseAsk";
import type { PermitId } from "../ipc/generated/lifecycle/PermitId";
import type { Reply } from "../ipc/generated/lifecycle/Reply";
import { log } from "../ipc/log";
import { noAnswerText, refusalText } from "../presentation/lifecycleWords";

export interface CwdArmingDeps {
  worktrees: CwdArming;
  refusals: Pick<ArmRefusalStore, "record">;
  lease(ask: LeaseAsk): Promise<Reply>;
  release(permit: PermitId): Promise<void>;
}

/** Why the machine granted no arm lease, in the words a refusal reads. */
function noLease(reply: Reply): string {
  if (reply.kind !== "answered") return noAnswerText(reply);
  if (reply.answer.kind === "refused") return refusalText(reply.answer.refusal);
  return `the lifecycle answered an arm lease with "${reply.answer.kind}"`;
}

export function createCwdArming(deps: CwdArmingDeps): CwdArmAsk {
  return async (agentId, request) => {
    const reply = await deps.lease({ kind: "arm", workspace: request.workspaceId, dir: request.cwd });
    let refused: { path: string; reason: string }[];
    if (reply.kind === "answered" && reply.answer.kind === "leased") {
      const permit = reply.answer.permit;
      try {
        refused = (await deps.worktrees.armCwd(request)).refused;
      } finally {
        void deps.release(permit).catch(() => {});
      }
    } else {
      const reason = noLease(reply);
      refused = request.arms.map(({ path }) => ({ path, reason }));
    }
    for (const { path, reason } of refused) {
      log.warn("web:arming", `${agentId}: ${request.cwd}/${path} not planted: ${reason}`);
    }
    deps.refusals.record(agentId, request.cwd, refused);
  };
}
