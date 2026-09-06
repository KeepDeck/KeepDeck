/**
 * Turning a settled roster into the things that have to happen.
 *
 * The steps belong to `applyTeamPlan`; what it needs to DO them — write the
 * roster, start an agent, tell the person, tell an agent — belongs here.
 * Those were built inside a JSX callback, which made the React tree the
 * only place that knew a recruit is started through the `team.add` command
 * and how to reach the mail manager. None of that survives the UI being
 * replaced by a CLI, so none of it was the view's.
 *
 * Owning them here is also what lets anything ELSE settle a team: a command,
 * an MCP tool, a test. The dialog becomes one caller among them.
 */
import type { TeamPlan } from "../../domain/mail";
import { applyTeamPlan, type TeamSetupDeps } from "./teamSetup";

export interface TeamFlowDeps {
  /** Write a settled roster — name and roles — as one deck change. */
  settleRoster: TeamSetupDeps["settleRoster"];
  /** Start an agent ON the team `teamId` under a role and answer with its
   * pane id. Through the `team.add` command, so every creation default —
   * the team's directory, YOLO, the full-team refusal — stays decided in
   * one place. */
  spawn(
    workspaceId: string,
    teamId: string,
    agentType: string,
    yolo: boolean,
    role: string,
  ): Promise<string | null>;
  /** Tell the person about a recruit that never started. */
  report(title: string, message: string): void;
  /** Tell an AGENT where it now stands. Resolved per call: the manager is
   * the mail service's, and a disposed service has none. */
  announce(paneId: string, kind: "team", body: string): void;
}

export interface TeamFlow {
  /** Apply a settled roster. */
  apply(workspaceId: string, plan: TeamPlan): Promise<void>;
}

export function createTeamFlow(deps: TeamFlowDeps): TeamFlow {
  return {
    apply: (workspaceId, plan) => applyTeamPlan(deps, workspaceId, plan),
  };
}
