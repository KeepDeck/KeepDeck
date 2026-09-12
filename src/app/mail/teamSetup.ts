/**
 * Applying a settled team plan: the roster as one write, and whoever is to
 * be started to fill the rest.
 *
 * One owner for the sequence rather than three calls at the surface. The
 * roster lands FIRST, whole — name and every role in one deck change, so a
 * handed-over address is free the moment its new holder takes it — and the
 * recruits go last because starting an agent is the only step that can fail
 * slowly.
 *
 * Spawning rides the EXISTING `team.add` command instead of a second
 * creation path — worktree, YOLO, the full-team refusal and the pane mint
 * are all decided there already, and a private copy of that reasoning
 * would drift the first time one of them changed. Nothing here ever makes
 * a team: a plan names one by id, and a team is born elsewhere, with its
 * directory and its first agent.
 */
import type { TeamPlan } from "../../domain/mail";

/**
 * What applying a plan needs.
 *
 * `spawn` is optional because a plan that asks for no recruit needs none:
 * settling a roster — which is what an agent does through `team.assign` —
 * creates nothing. A plan that DOES ask reports the missing port rather
 * than silently skipping the work.
 */
export interface TeamSetupDeps {
  /** Write the settled roster — the team's name and every member's role —
   * as ONE change. The plan was settled by `planTeam`, so the deck applies
   * it whole; nothing is ever half-applied. */
  settleRoster(
    workspaceId: string,
    teamId: string,
    name: string,
    members: readonly { paneId: string; role: string }[],
  ): void;
  /** Start an agent ON the team `teamId` in this workspace, under `role`,
   * answering with its pane id — the `team.add` command, so every creation
   * default stays in one place and the recruit lands on the team in the
   * same step that starts it. `yolo` is passed through rather than left to
   * the global default: the plan answers it per recruit, and dropping the
   * answer here would silently ignore it. */
  spawn?(
    workspaceId: string,
    teamId: string,
    agentType: string,
    yolo: boolean,
    role: string,
  ): Promise<string | null>;
  /** Tell the person about a recruit that never started. */
  report(title: string, message: string): void;
}

/**
 * Apply `plan` to `workspaceId`.
 *
 * A recruit that fails to start is reported and SKIPPED, not rolled back:
 * the roster already settled is a working team, and undoing it because a
 * fourth agent would not launch would take away what did work.
 *
 * Nobody is briefed from here. The roster write and every recruit's landing
 * reach the deck, and the briefing follows MEMBERSHIP off the deck
 * (`membershipWatch`) — for this door and every other. Telling members from
 * here as well was the second of two producers, composing the roster from
 * the plan because the deck "might not have caught up", and the first was
 * the door that got deleted with its call.
 */
export async function applyTeamPlan(
  deps: TeamSetupDeps,
  workspaceId: string,
  plan: TeamPlan,
): Promise<void> {
  deps.settleRoster(workspaceId, plan.teamId, plan.name, plan.members);
  for (const recruit of plan.recruits) {
    let paneId: string | null = null;
    try {
      if (!deps.spawn) throw new Error("this deck cannot start agents here");
      paneId = await deps.spawn(
        workspaceId,
        plan.teamId,
        recruit.agentType,
        recruit.yolo,
        recruit.role,
      );
    } catch (error) {
      paneId = null;
      deps.report(
        `Could not start ${recruit.agentType} as “${recruit.role}”`,
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    // A recruit that did start landed ON the team, under its role, by the
    // start itself — there is no second step in which the pane could be
    // found on no team, and nothing left to do for it here.
    if (!paneId) {
      deps.report(
        `Could not start ${recruit.agentType} as “${recruit.role}”`,
        "the team did not take a new agent",
      );
    }
  }
}
