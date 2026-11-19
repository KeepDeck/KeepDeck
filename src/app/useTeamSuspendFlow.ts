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
import { teamSuspendConfirmView, type TeamSuspendConfirmView } from "../presentation/teamSuspendView";
import type { AgentOrchestrator } from "./agentOrchestrator";

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
  /** Live activity by pane — the tracker's snapshot. */
  activities: ReadonlyMap<string, PaneActivity>;
  teamActs: AgentOrchestrator["teamActs"];
  suspendTeam: AgentOrchestrator["suspendTeam"];
}): TeamSuspendFlow {
  const [asked, setAsked] = useState<Asked | null>(null);
  const ws = asked ? findWorkspaceByRef(deps.workspaces, asked.workspace) : undefined;
  const team = ws && asked ? findTeam(ws, asked.teamId) : undefined;
  const acts = ws && team ? deps.teamActs(ws.id, team.id) : null;
  const shown = acts && asked ? stillTaken(acts.suspend, asked.named) : [];
  const confirming =
    ws && team ? teamSuspendConfirmView(team, membersOf(ws, team.id).length, shown, deps.activities) : null;
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
      if (!ws || !team || !asked || !confirming) return;
      void deps.suspendTeam(ws.id, team.id, asked.named);
    },
    cancel: () => setAsked(null),
  };
}
