/**
 * Applying a settled team plan: who leaves, who takes which role, and who
 * gets started to fill the rest.
 *
 * One owner for the sequence rather than three calls at the surface. The
 * order is the reason: releases go first so a role being handed from one
 * pane to another is free when the new holder takes it, and recruits go
 * last because starting an agent is the only step that can fail slowly.
 *
 * Spawning rides the EXISTING `agent.spawn` command instead of a second
 * creation path — worktree defaults, YOLO, the full-workspace refusal and
 * the pane mint are all decided there already, and a private copy of that
 * reasoning would drift the first time one of them changed.
 */
import type { TeamPlan } from "../../domain/mail";

export interface TeamSetupDeps {
  /** Put a pane on the team under a role, or take it off with `null`. */
  setPaneTeam(
    workspaceId: string,
    paneId: string,
    team: { name: string; role: string } | null,
  ): void;
  /** Start an agent in this workspace, answering with its pane id — the
   * `agent.spawn` command, so every creation default stays in one place. */
  spawn(workspaceId: string, agentType: string): Promise<string | null>;
  /** Tell the person about a recruit that never started. */
  report(title: string, message: string): void;
}

/**
 * Apply `plan` to `workspaceId`.
 *
 * A recruit that fails to start is reported and SKIPPED, not rolled back:
 * the members already placed are a working team, and undoing them because a
 * fourth agent would not launch would take away what did work.
 */
export async function applyTeamPlan(
  deps: TeamSetupDeps,
  workspaceId: string,
  plan: TeamPlan,
): Promise<void> {
  for (const paneId of plan.released) {
    deps.setPaneTeam(workspaceId, paneId, null);
  }
  for (const member of plan.members) {
    deps.setPaneTeam(workspaceId, member.paneId, {
      name: plan.name,
      role: member.role,
    });
  }
  for (const recruit of plan.recruits) {
    let paneId: string | null = null;
    try {
      paneId = await deps.spawn(workspaceId, recruit.agentType);
    } catch (error) {
      paneId = null;
      deps.report(
        `Could not start ${recruit.agentType} as “${recruit.role}”`,
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    if (!paneId) {
      deps.report(
        `Could not start ${recruit.agentType} as “${recruit.role}”`,
        "the workspace did not take a new agent",
      );
      continue;
    }
    deps.setPaneTeam(workspaceId, paneId, { name: plan.name, role: recruit.role });
  }
}
