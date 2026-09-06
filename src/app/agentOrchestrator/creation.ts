import {
  autoTeamName,
  autoWorkspaceName,
  findWorkspace,
  findWorkspaceByRef,
  membersOf,
  MAX_PANES,
  nextTeamSeq,
  normalizePath,
  teamHeldPath,
  teamId,
  teamNameTaken,
  teamOccupyingPath,
  teamOfPane,
  teamsOf,
  TEAM_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
  WORKTREE_HELD_MESSAGE,
  type Pane,
  type Team,
  type TeamLocation,
  type Workspace,
} from "../../domain/deck";
import { suggestRoleAddress } from "../../domain/mail";
import { createWorkspaceInstance, type WorkspaceRef } from "../../domain/workspaceInstance";
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
  /** Whether a confirmed close holds the team — the create runner then
   * stops at the directory it made, which is that close's to remove. */
  closing(workspace: WorkspaceRef, teamId: string): boolean;
}

export interface AgentOrchestratorCreation {
  landPane(request: CreatePaneRequest): CreatePaneOutcome;
  /** Whether `pane` could land at `placement` right now, without landing
   * it — the refusal it would meet, or null. For a caller with an
   * irreversible step to run BEFORE landing (a fork's store surgery) that
   * must not run for a pane the team then refuses. */
  roomFor(
    workspace: WorkspaceRef,
    pane: Pane,
    placement: TeamLocation,
  ): CreatePaneOutcome | null;
  landOrThrow(outcome: CreatePaneOutcome): void;
  /** Move a pane already in the deck onto the team holding `placement` —
   * minting that team when nobody holds it — off whatever team it was on.
   * What "start fresh" on a pane whose directory is gone does: the pane
   * comes back in the workspace root. The same refusals as a landing. */
  relocatePane(
    workspace: WorkspaceRef,
    paneId: string,
    placement: TeamLocation,
  ): CreatePaneOutcome;
  createWorkspace: AgentOrchestrator["createWorkspace"];
  retryProvisioning: AgentOrchestrator["retryProvisioning"];
}

/** The team a pane would land on, or the refusal it would meet. */
type Landing =
  | { team: Team & { location: TeamLocation }; fresh: boolean }
  | { refusal: "full" | "held" };

export function createAgentOrchestratorCreation({
  deck,
  actions,
  worktrees,
  closing,
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
    const ref = { id: workspace.id, instance: workspace.instance };
    void worktrees.provision(
      requests,
      workspace.name,
      provisionTeamsInto(actions, workspace.id, (teamId) => closing(ref, teamId)),
    );
  }

  function refuse(paneId: string, kind: "gone" | "full" | "held"): CreatePaneOutcome {
    dropPaneSpawnSpec(paneId);
    return { kind };
  }

  /**
   * The team a pane asking for `wanted` lands on in `current`: the one
   * holding that directory, or one minted for it — or the refusal.
   *
   * ONE directory is ONE team: a request naming a directory a team in this
   * workspace already holds JOINS that team, and a directory a team in
   * another workspace holds is refused — a team never spans workspaces,
   * except at the root, which every workspace opened on the same repository
   * holds for itself. A directory nobody holds gets a team of its own, named
   * after the pane when the person named it and "Team N" otherwise.
   */
  function resolveLanding(
    workspaces: readonly Workspace[],
    current: Workspace,
    pane: Pane,
    wanted: TeamLocation,
    /** The pane's own membership, when it is relocating: it does not count
     * toward its own team's cap. */
    except?: string,
  ): Landing {
    const wantedKey = normalizePath(teamHeldPath({ location: wanted }) ?? "");
    const holder = teamsOf(current).find((candidate) => {
      const held = teamHeldPath(candidate);
      return held !== undefined && normalizePath(held) === wantedKey;
    });
    let team: Team & { location: TeamLocation };
    let fresh = false;
    if (holder?.location) {
      team = { ...holder, location: holder.location };
    } else {
      const elsewhere = teamOccupyingPath(workspaces, wantedKey);
      if (elsewhere && wantedKey !== normalizePath(current.cwd)) return { refusal: "held" };
      const seq = nextTeamSeq(workspaces);
      const asked = pane.name?.trim();
      const name = asked && !teamNameTaken(current, asked) ? asked : autoTeamName(seq);
      team = { id: teamId(seq), name, location: wanted };
      fresh = true;
    }
    const members = membersOf(current, team.id).filter((member) => member.id !== except);
    if (members.length >= MAX_PANES) return { refusal: "full" };
    return { team, fresh };
  }

  /** Put `pane` on the landing's team: the team minted when fresh, the
   * membership written under a role the dialog would suggest, and a fresh
   * team's create issued. */
  function join(
    current: Workspace,
    pane: Pane,
    landing: { team: Team & { location: TeamLocation }; fresh: boolean },
    postProvision: CreatePaneRequest["postProvision"],
  ): void {
    const { team, fresh } = landing;
    const role = suggestRoleAddress(
      membersOf(current, team.id).flatMap((member) => (member.team ? [member.team.role] : [])),
    );
    if (fresh) actions.createTeam(current.id, team);
    actions.joinTeam(current.id, pane.id, team.id, role);
    if (fresh && team.location.kind === "provisioning") {
      // The step rides the request and is filed under the team the landing
      // just minted — the only id that could not have been known before.
      if (postProvision) worktrees.registerPostProvision(team.id, postProvision);
      provisionTeams(current, [team]);
    }
  }

  const rootOf = (workspace: Workspace): TeamLocation => ({
    kind: "attached",
    cwd: workspace.cwd,
  });

  function roomFor(
    workspace: WorkspaceRef,
    pane: Pane,
    placement: TeamLocation,
  ): CreatePaneOutcome | null {
    const workspaces = deck.getSnapshot().workspaces;
    const current = findWorkspaceByRef(workspaces, workspace);
    if (!current) return { kind: "gone" };
    const landing = resolveLanding(workspaces, current, pane, placement);
    return "refusal" in landing ? { kind: landing.refusal } : null;
  }

  /**
   * Land a pane on the team that holds the directory it asked for, minting
   * that team when nobody holds it yet. The pane itself lands without a
   * placement of its own: from here on its directory is a question about
   * its team. A request naming no placement lands in the workspace root.
   */
  function landPane({ workspace, pane, placement, postProvision }: CreatePaneRequest): CreatePaneOutcome {
    const workspaces = deck.getSnapshot().workspaces;
    const current = findWorkspaceByRef(workspaces, workspace);
    if (!current) return refuse(pane.id, "gone");
    const landing = resolveLanding(workspaces, current, pane, placement ?? rootOf(current));
    if ("refusal" in landing) return refuse(pane.id, landing.refusal);
    actions.addAgentPane(current.id, pane);
    join(current, pane, landing, postProvision);
    return { kind: "created", teamId: landing.team.id };
  }

  function relocatePane(
    workspace: WorkspaceRef,
    paneId: string,
    placement: TeamLocation,
  ): CreatePaneOutcome {
    const workspaces = deck.getSnapshot().workspaces;
    const current = findWorkspaceByRef(workspaces, workspace);
    const pane = current?.panes.find((candidate) => candidate.id === paneId);
    if (!current || !pane) return { kind: "gone" };
    const landing = resolveLanding(workspaces, current, pane, placement, pane.id);
    if ("refusal" in landing) return { kind: landing.refusal };
    // Already there: nothing to move.
    if (teamOfPane(current, pane)?.id === landing.team.id) {
      return { kind: "created", teamId: landing.team.id };
    }
    actions.leaveTeam(current.id, pane.id);
    join(current, pane, landing, undefined);
    return { kind: "created", teamId: landing.team.id };
  }

  function landOrThrow(outcome: CreatePaneOutcome): void {
    switch (outcome.kind) {
      case "created":
        return;
      case "full":
        throw new Error(TEAM_FULL_MESSAGE);
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

  return { landPane, roomFor, relocatePane, landOrThrow, createWorkspace, retryProvisioning };
}
