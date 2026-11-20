/**
 * The notices' owner for the lifecycle machine's commands: what a cleanup
 * could not do, said once in the notification center. A notice asked again
 * after a restart replaces the one it left rather than stacking a second.
 */
import type { Outcome } from "../../ipc/generated/lifecycle/Outcome";
import { worktreeNotDeletedNotice } from "../../presentation/closeWords";
import type { CommandOwner } from "../lifecycleSnapshot";
import type { NotificationCenter } from "../notificationCenter";

const DONE: Outcome = { kind: "applied", revision: null };

export function createNoticesOwner(center: Pick<NotificationCenter, "notify">): CommandOwner {
  return {
    carry({ cmd }) {
      if (cmd.kind !== "worktreeNotDeleted") {
        return Promise.resolve({ kind: "rejected", reason: `the notices carry no ${cmd.kind} command` });
      }
      center.notify({
        ...worktreeNotDeletedNotice(cmd.path, cmd.reason),
        severity: "warning",
        source: { type: "app" },
        tag: `worktree-not-deleted:${cmd.path}`,
      });
      return Promise.resolve(DONE);
    },
  };
}
