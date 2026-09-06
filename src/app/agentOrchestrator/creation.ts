import {
  autoTeamName,
  autoWorkspaceName,
  findWorkspace,
  findWorkspaceByRef,
  locationOf,
  membersOf,
  MAX_PANES,
  nextTeamSeq,
  teamHeldPath,
  teamId,
  teamNameTaken,
  teamOccupyingPath,
  teamsOf,
  WORKSPACE_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
  WORKTREE_HELD_MESSAGE,
  type Pane,
  type Team,
  type TeamLocation,
  type Workspace,
} from "../../domain/deck";
import { suggestRoleAddress } from "../../domain/mail";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { log } from "../../ipc/log";
import type {
  AgentOrchestrator,
  CreatePaneOutcome,
  CreatePaneRequest,
} from ".";
import type { DeckActions } from "../deckActions";
import type { DeckStore } from "../deckStore";
import { provisionTeamsInto } from "../provisioning";
import { dropPaneSpawnSpec } from "../spawnSpecs";
import type { WorktreeProvisioner } from "../worktrees";

interface CreationDeps {
  deck: DeckStore;
  actions: DeckActions;
  worktrees: WorktreeProvisioner;
}

export interface AgentOrchestratorCreation {
  landPane(request: CreatePaneRequest): CreatePaneOutcome;
  /** Whether `pane` could land right now, without landing it — the refusal
   * it would meet, or null. For a caller with an irreversible step to run
   * BEFORE landing (a fork's store surgery) that must not run for a pane
   * the team then refuses. */
  roomFor(workspace: CreatePaneRequest["workspace"], pane: Pane): CreatePaneOutcome | null;
  landOrThrow(outcome: CreatePaneOutcome): void;
  createWorkspace: AgentOrchestrator["createWorkspace"];
  retryProvisioning: AgentOrchestrator["retryProvisioning"];
}

/** Path spelling differences that don't change the directory — the same
 * rule occupancy applies. */
function directoryKey(path: string): string {
  const trimmed = path.trim();
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" ? trimmed : stripped;
}

/**
 * The directory a pane REQUEST asks for, as a team's placement.
 *
 * A pane's own placement said one of four things; three of them name a
 * directory the team will hold, and the fourth — the workspace root, or a
 * remote endpoint whose thin client runs there — names the root, which is a
 * directory like any other. The branch a root request recorded rides along:
 * it is the branch the session ran on, and the root's team keeps it.
 */
function requestedPlacement(pane: Pane, workspace: Workspace): TeamLocation {
  const own = locationOf(pane);
  switch (own.kind) {
    case "attached":
      return own;
    case "provisioning":
      // The intent and the fork marker: a fork's card is the team's now,
      // and the marker is what keeps an in-flight fork off the disk.
      return { kind: "provisioning", intent: own.intent, ...(own.fork && { fork: true }) };
    case "main":
      return own.branch !== undefined
        ? { kind: "attached", cwd: workspace.cwd, branch: own.branch }
        : { kind: "attached", cwd: workspace.cwd };
    case "remote":
      return { kind: "attached", cwd: workspace.cwd };
  }
}

/** The pane as it lands: its placement is the team's now. A remote
 * endpoint is the pane's own — its thin client runs in the team's directory
 * — so that one stays. */
function withoutPlacement(pane: Pane): Pane {
  const { location, ...rest } = pane;
  return location?.kind === "remote" ? { ...rest, location } : rest;
}

export function createAgentOrchestratorCreation({
  deck,
  actions,
  worktrees,
}: CreationDeps): AgentOrchestratorCreation {
  /** Start the creates behind `teams`' cards. The workspace's name goes with
   * them as it is NOW: an auto branch name follows what the workspace is
   * called when its create is issued, so a Retry after a rename lands on the
   * new name rather than on one a card remembered. */
  function provisionTeams(workspace: Workspace, teams: readonly Team[]): void {
    const requests = teams.flatMap((team) =>
      team.location?.kind === "provisioning"
        ? [{ ownerId: team.id, intent: team.location.intent }]
        : [],
    );
    if (requests.length === 0) return;
    void worktrees.provision(requests, workspace.name, provisionTeamsInto(actions, workspace.id));
  }

  function refuse(paneId: string, kind: "gone" | "full" | "held"): CreatePaneOutcome {
    dropPaneSpawnSpec(paneId);
    return { kind };
  }

  /**
   * Land a pane on the team that holds the directory it asked for, minting
   * that team when nobody holds it yet.
   *
   * ONE directory is ONE team: a request naming a directory a team in this
   * workspace already holds JOINS that team (a role minted the way the dialog
   * would), and a directory a team in another workspace holds is refused —
   * a team never spans workspaces. A directory nobody holds gets a team of
   * its own, named after the pane when the person named it and "Team N"
   * otherwise, and a create heading for a directory is issued for the TEAM.
   * The pane itself lands without a placement: from here on its directory
   * is a question about its team.
   */
  /** The team `pane` would land on in `current` — the one holding the
   * directory it asked for, or one minted for it — or the refusal. */
  function resolveLanding(
    workspaces: readonly Workspace[],
    current: Workspace,
    pane: Pane,
  ):
    | { team: Team & { location: TeamLocation }; fresh: boolean }
    | { refusal: "full" | "held" } {
    const wanted = requestedPlacement(pane, current);
    const wantedKey = directoryKey(teamHeldPath({ location: wanted }) ?? "");
    const holder = teamsOf(current).find((candidate) => {
      const held = teamHeldPath(candidate);
      return held !== undefined && directoryKey(held) === wantedKey;
    });
    let team: Team & { location: TeamLocation };
    let fresh = false;
    if (holder?.location) {
      team = { ...holder, location: holder.location };
    } else {
      // Held elsewhere: refused — except the root, which every workspace
      // opened on the same repository holds for itself.
      const elsewhere = teamOccupyingPath(workspaces, wantedKey);
      if (elsewhere && wantedKey !== directoryKey(current.cwd)) return { refusal: "held" };
      const seq = nextTeamSeq(workspaces);
      const asked = pane.name?.trim();
      const name = asked && !teamNameTaken(current, asked) ? asked : autoTeamName(seq);
      team = { id: teamId(seq), name, location: wanted };
      fresh = true;
    }
    if (membersOf(current, team.id).length >= MAX_PANES) return { refusal: "full" };
    return { team, fresh };
  }

  function roomFor(
    workspace: CreatePaneRequest["workspace"],
    pane: Pane,
  ): CreatePaneOutcome | null {
    const workspaces = deck.getSnapshot().workspaces;
    const current = findWorkspaceByRef(workspaces, workspace);
    if (!current) return { kind: "gone" };
    const landing = resolveLanding(workspaces, current, pane);
    return "refusal" in landing ? { kind: landing.refusal } : null;
  }

  function landPane({ workspace, pane, postProvision }: CreatePaneRequest): CreatePaneOutcome {
    const workspaces = deck.getSnapshot().workspaces;
    const current = findWorkspaceByRef(workspaces, workspace);
    if (!current) return refuse(pane.id, "gone");
    const landing = resolveLanding(workspaces, current, pane);
    if ("refusal" in landing) return refuse(pane.id, landing.refusal);
    const { team, fresh } = landing;

    const role = suggestRoleAddress(
      membersOf(current, team.id).flatMap((member) => (member.team ? [member.team.role] : [])),
    );
    if (fresh) actions.createTeam(current.id, team);
    actions.addAgentPane(current.id, withoutPlacement(pane));
    actions.joinTeam(current.id, pane.id, team.id, role);
    if (fresh && team.location.kind === "provisioning") {
      // The step rides the request and is filed under the team the landing
      // just minted — the only id that could not have been known before.
      if (postProvision) worktrees.registerPostProvision(team.id, postProvision);
      provisionTeams(current, [team]);
    }
    return { kind: "created", teamId: team.id };
  }

  function landOrThrow(outcome: CreatePaneOutcome): void {
    switch (outcome.kind) {
      case "created":
        return;
      case "full":
        throw new Error(WORKSPACE_FULL_MESSAGE);
      case "gone":
        throw new Error(WORKSPACE_GONE_MESSAGE);
      case "held":
        throw new Error(WORKTREE_HELD_MESSAGE);
      default: {
        const unhandled: never = outcome;
        throw new Error(`unhandled create outcome: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** A workspace is born EMPTY: nothing spawns here, so nothing is provisioned
   * here either. Agents arrive one at a time through `landPane`, each carrying
   * the directory its team will hold — which is where a worktree create is
   * started now. */
  const createWorkspace: AgentOrchestrator["createWorkspace"] = (config) => {
    const created = actions.createWorkspaceFromSequence((sequence): Workspace => {
      const id = `ws-${sequence}`;
      // The same derivation an empty rename resets to — one home, so the
      // birth name and the reset name cannot drift apart.
      const name = config.name.trim() || autoWorkspaceName(id);
      return {
        id,
        instance: createWorkspaceInstance(),
        name,
        cwd: config.cwd,
        worktreeBaseDir: config.worktreeBaseDir,
        panes: [],
      };
    });
    if (!created.ok) {
      log.error(
        "web:orchestrator",
        `workspace create rejected: ${created.reason}`,
      );
    }
    return created;
  };

  /** Re-issue a team's failed create: the error clears (the card goes back
   * to creating) and the same intent goes out again under the workspace's
   * name as it is now. */
  const retryProvisioning: AgentOrchestrator["retryProvisioning"] = (wsId, teamId) => {
    const workspace = findWorkspace(deck.getSnapshot().workspaces, wsId);
    const team = workspace ? teamsOf(workspace).find((candidate) => candidate.id === teamId) : undefined;
    if (!workspace || !team || team.location?.kind !== "provisioning") return;
    actions.setTeamProvisioningError(wsId, teamId, null);
    provisionTeams(workspace, [team]);
  };

  return { landPane, roomFor, landOrThrow, createWorkspace, retryProvisioning };
}
