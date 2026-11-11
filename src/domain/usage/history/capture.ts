import type { UsageCall } from "@keepdeck/plugin-api";
import { paneWorktree, teamOfPane, type Pane, type Workspace } from "../../deck";

/** The deck's facts about where usage happened: the pane and its workspace,
 * read back whole with every row the usage history serves. */
export interface UsagePlace {
  workspaceId: string;
  workspaceName: string;
  workspaceCwd: string;
  paneId: string;
  paneName: string;
  worktree?: {
    path: string;
    branch?: string;
    repo: string;
  };
  /** The team the pane was on when its calls were booked. */
  team?: UsageTeam;
}

/** A team as a usage row remembers it: its id, its NAME AT THE TIME — a
 * renamed or disbanded team must still read as what it was called when the
 * money was spent — and the pane's role on it. */
export interface UsageTeam {
  id: string;
  name: string;
  role: string;
}

/** Where a pane's usage happens: its workspace, its name as the history
 * shows it (the user's name for it, else its own title, else its place in
 * the workspace), the worktree it works in and the team it is on. */
export function usagePlace(workspace: Workspace, pane: Pane): UsagePlace {
  const worktree = paneWorktree(workspace, pane);
  const team = teamOfPane(workspace, pane);
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceCwd: workspace.cwd,
    paneId: pane.id,
    paneName: pane.name ?? pane.autoTitle ?? `Agent ${workspace.panes.indexOf(pane) + 1}`,
    ...(worktree
      ? {
          worktree: {
            path: worktree.cwd,
            repo: workspace.cwd,
            ...(worktree.branch ? { branch: worktree.branch } : {}),
          },
        }
      : {}),
    ...(team && pane.team ? { team: { id: team.id, name: team.name, role: pane.team.role } } : {}),
  };
}

/**
 * Calls one pane reported for one session, as the usage history books them.
 *
 * `firstSeen` is when the deck's session binding accepted the session for the
 * pane, by the deck's clock: the usage history books no call older than the
 * first time it saw a session — a fork's copies and what the session spent
 * before KeepDeck watched it are both older (user decision 2026-11-08).
 */
export interface UsageCallBatch {
  agent: string;
  sessionId: string;
  firstSeen: number;
  place: UsagePlace;
  calls: readonly UsageCall[];
}
