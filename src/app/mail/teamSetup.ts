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
import { teamBriefing, teamFarewell, type TeamPlan } from "../../domain/mail";

/**
 * What applying a plan needs.
 *
 * `spawn` and `close` are optional because a plan that asks for neither
 * needs neither: settling a roster — which is what an agent does through
 * `team.assign` — creates and ends nothing. A plan that DOES ask reports the
 * missing port rather than silently skipping the work.
 */
export interface TeamSetupDeps {
  /** Put a pane on the team under a role, or take it off with `null`. */
  setPaneTeam(
    workspaceId: string,
    paneId: string,
    team: { name: string; role: string } | null,
  ): void;
  /** Start an agent in this workspace, answering with its pane id — the
   * `agent.spawn` command, so every creation default stays in one place.
   * `yolo` is passed through rather than left to the global default: the
   * dialog asked per recruit, and dropping the answer here would silently
   * ignore it. */
  spawn?(
    workspaceId: string,
    agentType: string,
    yolo: boolean,
  ): Promise<string | null>;
  /** End an agent — the same close the confirmation surface performs, minus
   * the confirmation, because the person already gave it once for the whole
   * team. Worktrees are deliberately NOT part of it: deleting one is its own
   * destructive decision and has no business riding an organisational act. */
  close?(workspaceId: string, paneId: string): Promise<void>;
  /** Tell the person about a recruit that never started. */
  report(title: string, message: string): void;
  /** Tell an AGENT where it now stands. Absent when the mail feature is
   * off — the roles are still recorded, there is simply nothing running to
   * tell. */
  announce?(paneId: string, kind: "team", body: string): void;
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
  /**
   * Panes to END as well as release, named by the caller and never by the
   * plan.
   *
   * Ending an agent is not part of settling a roster — it is a second thing
   * the person asked for in the same breath, and only one gesture offers it.
   * Keeping it out of `TeamPlan` is what stops an ordinary edit from ever
   * carrying one: a plan has no field to put it in.
   */
  closing: readonly string[] = [],
): Promise<void> {
  /** Who ends up on the team, in roster order — the briefing's content. */
  const landed: { paneId: string; role: string }[] = [];
  for (const paneId of plan.released) {
    deps.setPaneTeam(workspaceId, paneId, null);
  }
  for (const member of plan.members) {
    deps.setPaneTeam(workspaceId, member.paneId, {
      name: plan.name,
      role: member.role,
    });
    landed.push(member);
  }
  for (const recruit of plan.recruits) {
    let paneId: string | null = null;
    try {
      if (!deps.spawn) throw new Error("this deck cannot start agents here");
      paneId = await deps.spawn(workspaceId, recruit.agentType, recruit.yolo);
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
    landed.push({ paneId, role: recruit.role });
  }

  // Told LAST, and only about what actually landed: a briefing naming a
  // teammate whose agent failed to start would send someone writing into
  // nothing. Composed from the plan rather than re-read from the deck,
  // because the deck's own view of a dispatch made a moment ago is not
  // guaranteed to have caught up.
  const everyRole = landed.map((member) => member.role);
  for (const member of landed) {
    deps.announce?.(
      member.paneId,
      "team",
      teamBriefing(plan.name, member.role, everyRole),
    );
  }
  // And whoever left hears once, so it stops addressing roles that no
  // longer reach anyone — except the ones being closed, who have nothing
  // left to say it to.
  const ending = new Set(closing);
  for (const paneId of plan.released) {
    if (ending.has(paneId)) continue;
    deps.announce?.(paneId, "team", teamFarewell(plan.name));
  }

  // Closing comes LAST, after every pane has been taken off the team. A
  // close that fails then leaves an agent that is merely off the team,
  // which is the disband the person asked for either way; doing it first
  // would leave a failed close holding a role on a team that no longer
  // exists.
  //
  // One at a time, and a failure is reported rather than thrown: the person
  // asked to end four agents, and the three that ended should not be undone
  // by the fourth. Each close is the same one the confirmation surface
  // performs — they gave that confirmation once, for the team.
  for (const paneId of closing) {
    try {
      if (!deps.close) throw new Error("this deck cannot end agents here");
      await deps.close(workspaceId, paneId);
    } catch (error) {
      deps.report(
        "Could not close an agent",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
