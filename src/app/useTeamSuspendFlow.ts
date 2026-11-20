/**
 * Stopping a team, as the person asks for it: a confirm first — always, by
 * the person's decision, whatever its agents are doing — then the
 * orchestrator's team Suspend.
 *
 * The confirm is a TRANSACTION, like Archive: it holds the keyboard and sits
 * over every dialog. It names the members whom the team's Suspend would
 * take when it was asked for, and only those: one that comes up while it
 * stands is not stopped by a confirm that never named it. The words are read
 * live (`teamSuspendConfirmView`), so a member stopped elsewhere meanwhile
 * leaves the count, and a confirm left with nobody to stop — the team gone,
 * every member down — goes away instead of asking about nothing.
 */
import { useState } from "react";
import { findTeam, findWorkspaceByRef, membersOf, stillTaken, type Workspace } from "../domain/deck";
import type { PaneActivity } from "../domain/status";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import type { AgentInfo } from "../domain/agents";
import { suspendResultText } from "../presentation/suspendWords";
import { teamSuspendConfirmView, type TeamSuspendConfirmView } from "../presentation/teamSuspendView";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { membersNotTakenText, paneLabelsIn } from "./memberOutcomes";

export interface TeamSuspendFlow {
  /** The confirm standing, or null. */
  confirming: TeamSuspendConfirmView | null;
  request(wsId: string, teamId: string): void;
  confirm(): void;
  cancel(): void;
}

interface Asked {
  workspace: WorkspaceRef;
  teamId: string;
  /** Whom the Suspend would take when it was asked for. */
  named: readonly string[];
}

export function useTeamSuspendFlow(deps: {
  workspaces: Workspace[];
  /** The installed agents — what a member is named by when one is not
   * stopped. */
  agents: AgentInfo[];
  /** Live activity by pane — the tracker's snapshot. */
  activities: ReadonlyMap<string, PaneActivity>;
  teamActs: AgentOrchestrator["teamActs"];
  suspendTeam: AgentOrchestrator["suspendTeam"];
  /** Say the members the Suspend did not stop, and why. */
  onRefused(message: string): void;
}): TeamSuspendFlow {
  const [asked, setAsked] = useState<Asked | null>(null);
  const ws = asked ? findWorkspaceByRef(deps.workspaces, asked.workspace) : undefined;
  const team = ws && asked ? findTeam(ws, asked.teamId) : undefined;
  const acts = ws && team ? deps.teamActs(ws.id, team.id) : null;
  const shown = acts && asked ? stillTaken(acts.suspend, asked.named) : [];
  const confirming =
    ws && team ? teamSuspendConfirmView(team, membersOf(ws, team.id).length, shown, deps.activities) : null;
  // A confirm left with nobody to stop is OVER, not hidden: were it kept,
  // a named member coming back up would raise it again with no one having
  // asked. Ended in the render that sees it go (React's own pattern for
  // state that follows what is rendered), so no stale ask outlives it.
  if (asked && !confirming) setAsked(null);
  return {
    confirming,
    request(wsId, teamId) {
      const target = deps.workspaces.find((candidate) => candidate.id === wsId);
      const named = target ? (deps.teamActs(wsId, teamId)?.suspend.take ?? []) : [];
      if (target && named.length > 0) {
        setAsked({ workspace: { id: target.id, instance: target.instance }, teamId, named });
      }
    },
    confirm() {
      setAsked(null);
      if (!ws || !team || !confirming) return;
      // What the person CONFIRMED is what the dialog showed: the door judges
      // that scope again, and never widens it — a member that became
      // stoppable after the last render was not on the dialog. A member the
      // machine did not stop is said by name, never dropped.
      const labels = paneLabelsIn(deps.workspaces, deps.agents, ws.id);
      void deps.suspendTeam(ws.id, team.id, confirming.shown).then((answers) => {
        const refused = membersNotTakenText(answers, labels, suspendResultText);
        if (refused !== null) deps.onRefused(refused);
      });
    },
    cancel: () => setAsked(null),
  };
}
