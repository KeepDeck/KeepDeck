/**
 * What the deck tells the lifecycle machine at the boot handshake: every
 * workspace, team and pane as the deck holds them, so the machine reconciles
 * its journal against the person's deck and nothing else. The deck's own
 * spelling of each row stays the deck's; this is the one projection the
 * machine reads.
 */
import type { Pane } from "../deck/panes/model";
import { remoteEndpointOf } from "../deck/panes/model";
import type { Team } from "../deck/teams/model";
import type { Workspace } from "../deck/workspaces";

/** Where the deck says a team runs. */
export type TeamAtFacts =
  | { kind: "attached"; cwd: string; branch: string | null }
  | { kind: "provisioning"; path: string; branch: string | null }
  | { kind: "unplaced" };

export interface TeamFacts {
  id: string;
  at: TeamAtFacts;
}

export interface PaneFacts {
  id: string;
  team: string | null;
  /** A remote pane runs on an endpoint, in no folder of ours. */
  remote: boolean;
  suspended: boolean;
}

export interface WorkspaceFacts {
  id: string;
  name: string;
  cwd: string;
  /** Where its new worktrees go; none: a new worktree needs a place typed by
   * hand. */
  worktreeBase: string | null;
  archived: boolean;
  /** The deck's archive marker says an archive was under way. */
  archiving: boolean;
  teams: TeamFacts[];
  panes: PaneFacts[];
}

export interface DeckFacts {
  workspaces: WorkspaceFacts[];
}

function teamAt(team: Team): TeamAtFacts {
  const location = team.location;
  if (!location) return { kind: "unplaced" };
  if (location.kind === "attached") return { kind: "attached", cwd: location.cwd, branch: location.branch ?? null };
  return { kind: "provisioning", path: location.intent.path, branch: location.intent.branch ?? null };
}

function paneFacts(pane: Pane): PaneFacts {
  return {
    id: pane.id,
    team: pane.team?.teamId ?? null,
    remote: remoteEndpointOf(pane) !== null,
    suspended: pane.idle?.reason === "suspended",
  };
}

/** The deck as the handshake hands it over. */
export function deckFactsOf(workspaces: readonly Workspace[]): DeckFacts {
  return {
    workspaces: workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      cwd: ws.cwd,
      worktreeBase: ws.worktreeBaseDir,
      archived: ws.archived?.phase === "archived",
      archiving: ws.archived?.phase === "archiving",
      teams: (ws.teams ?? []).map((team) => ({ id: team.id, at: teamAt(team) })),
      panes: ws.panes.map(paneFacts),
    })),
  };
}
