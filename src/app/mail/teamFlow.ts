/**
 * Turning a settled roster into the things that have to happen.
 *
 * The steps belong to `applyTeamPlan`; what it needs to DO them — start an
 * agent, end one, tell the person, tell an agent — belongs here. Those four
 * were built inside a JSX callback, which made the React tree the only place
 * that knew a recruit is started through the `agent.spawn` command, that
 * ending a member never deletes its worktree, and how to reach the mail
 * manager. None of that survives the UI being replaced by a CLI, so none of
 * it was the view's.
 *
 * Owning them here is also what lets anything ELSE settle a team: a command,
 * an MCP tool, a test. The dialog becomes one caller among them.
 */
import type { TeamPlan } from "../../domain/mail";
import { applyTeamPlan, type TeamSetupDeps } from "./teamSetup";

export interface TeamFlowDeps {
  /** Record a pane's place on a team, or take it off one. */
  setPaneTeam: TeamSetupDeps["setPaneTeam"];
  /** Start an agent and answer with its pane id. Through the command, so
   * every creation default — worktree, YOLO, the full-workspace refusal —
   * stays decided in one place. */
  spawn(workspaceId: string, agentType: string, yolo: boolean): Promise<string | null>;
  /** End an agent. Worktrees are deliberately untouched: deleting one is its
   * own destructive decision and has no business riding an organisational
   * act. */
  close(workspaceId: string, paneId: string): Promise<void>;
  /** Tell the person about a recruit that never started. */
  report(title: string, message: string): void;
  /** Tell an AGENT where it now stands. Resolved per call: mail is an
   * Experimental toggle, and it can go off between two applies. */
  announce(paneId: string, kind: "team", body: string): void;
}

export interface TeamFlow {
  /**
   * Apply a settled roster, ending `closing` as well when the person asked
   * for that in the same breath.
   */
  apply(
    workspaceId: string,
    plan: TeamPlan,
    closing?: readonly string[],
  ): Promise<void>;
}

export function createTeamFlow(deps: TeamFlowDeps): TeamFlow {
  return {
    apply: (workspaceId, plan, closing) =>
      applyTeamPlan(deps, workspaceId, plan, closing),
  };
}
