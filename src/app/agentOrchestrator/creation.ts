import {
  autoTeamName,
  autoWorkspaceName,
  birthRefusal,
  claimDirectory,
  findTeam,
  findWorkspace,
  findWorkspaceByRef,
  membersOf,
  MAX_PANES,
  nextTeamSeq,
  normalizePath,
  roleTaken,
  teamHeldPath,
  teamId,
  teamNameTaken,
  teamOfPane,
  teamsOf,
  placementRefusalMessage,
  TEAM_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
  type DirectoryClaim,
  type Pane,
  type PlacementRefusal,
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
  CreateTeamOutcome,
  CreateTeamRequest,
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
   * stops at the directory it made, which is that close's to remove, and
   * the landing refuses to put a pane on it. */
  closing(workspace: WorkspaceRef, teamId: string): boolean;
  /** Whether a confirmed close is still finishing with the directory — the
   * team is out of the deck, the `git worktree remove` is not done. A
   * landing there would hand the directory to a team the teardown is
   * about to delete it from under. */
  holdsPath(path: string): boolean;
}

export interface AgentOrchestratorCreation {
  landPane(request: CreatePaneRequest): CreatePaneOutcome;
  createTeam(request: CreateTeamRequest): CreateTeamOutcome;
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

/** The workspace root as a placement: a directory like any other. */
const rootOf = (workspace: Workspace): TeamLocation => ({
  kind: "attached",
  cwd: workspace.cwd,
});

/** The team a pane would land on, or the refusal it would meet. */
type Landing =
  | { team: Team & { location: TeamLocation }; fresh: boolean }
  | { refusal: "full" }
  | { refusal: "held"; why: PlacementRefusal };

/**
 * The birth policy ([`birthRefusal`]) said in the outcomes a door answers
 * with, minus the runtime facts only a running deck holds (a teardown still
 * removing the directory). `null` = go ahead.
 *
 * The door, the `team.create` command and the command double all answer
 * through this — one spelling, so no second implementation can drift from it
 * while its tests still pass. The POLICY itself is the domain's; this only
 * dresses it, and names the holder so the asker can say whose directory it is.
 */
export function teamCreateRefusal(request: {
  claim: DirectoryClaim;
  /** What the team asked for — a create heading for a directory is refused
   * on this side of the question too. */
  placement: TeamLocation;
  /** The workspace the team would be born in — a holder anywhere else is
   * named with its workspace, since no `team.add` here can reach it. */
  homeWsId: string;
  /** The directory as the deck keys it, for the asker to name. */
  directory: string;
  /** The person (or agent) has already answered "create anyway". */
  shared: boolean;
}): Extract<CreateTeamOutcome, { kind: "held" | "shared" }> | null {
  const { claim, placement, homeWsId, directory, shared } = request;
  const refusal = birthRefusal(claim, placement, shared);
  if (refusal === null) return null;
  if (refusal !== "unshared" || claim.kind === "free") {
    // Which half of the worktree rule refused: a create still out there
    // (wait), or ours onto a directory a team works in (never).
    return { kind: "held", why: claim.kind === "held" && claim.creating ? "creating" : "occupied" };
  }
  return {
    kind: "shared",
    directory,
    holder: {
      teamId: claim.team.id,
      teamName: claim.team.name,
      ...(claim.ws.id !== homeWsId && { workspace: claim.ws.name }),
    },
  };
}

export function createAgentOrchestratorCreation({
  deck,
  actions,
  worktrees,
  closing,
  holdsPath,
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

  function refuse(paneId: string, outcome: CreatePaneOutcome): CreatePaneOutcome {
    dropPaneSpawnSpec(paneId);
    return outcome;
  }

  /** A landing's refusal as the outcome a caller answers with — the `why`
   * rides along so the door can say which refusal it was. */
  function refusalOutcome(landing: Extract<Landing, { refusal: string }>): CreatePaneOutcome {
    return landing.refusal === "full"
      ? { kind: "full" }
      : { kind: "held", why: landing.why };
  }

  /**
   * Make a team that holds `placement` and nobody yet — the "+ Team" door.
   *
   * A directory teams already WORK in takes another team when the person
   * says so: the create answers `shared` naming who is there, and the same
   * request carrying `shared` goes through. Teams sharing a directory is a
   * real way of working — several teams on one checkout — not an accident
   * to be prevented, so the door asks instead of refusing.
   *
   * Two things consent cannot buy, and both answer `held`: a directory a
   * create is still heading for (a worktree cannot be made where one is
   * being made, on either side of the question), and one a confirmed close
   * is still tearing down — that team would lose its directory seconds
   * later. A name a team here answers to is `taken`.
   *
   * The deck is read back rather than trusted, and the create behind a card
   * is issued only once the deck holds the team.
   */
  function createTeam(request: CreateTeamRequest): CreateTeamOutcome {
    const workspaces = deck.getSnapshot().workspaces;
    const current = findWorkspaceByRef(workspaces, request.workspace);
    if (!current) return { kind: "gone" };
    const wanted = request.placement;
    const wantedKey = normalizePath(teamHeldPath({ location: wanted }) ?? "");
    // A teardown owns the directory until its `git worktree remove` is done
    // — runtime state the deck cannot see, and the one refusal this layer
    // adds to the claim.
    if (holdsPath(wantedKey)) return { kind: "held", why: "removing" };
    const refusal = teamCreateRefusal({
      claim: claimDirectory(workspaces, current, wanted),
      placement: wanted,
      homeWsId: current.id,
      directory: wantedKey,
      shared: request.shared === true,
    });
    if (refusal) return refusal;
    const seq = nextTeamSeq(workspaces);
    const name = request.name.trim() || autoTeamName(seq);
    if (teamNameTaken(current, name)) return { kind: "taken" };
    const team: Team & { location: TeamLocation } = { id: teamId(seq), name, location: wanted };
    actions.createTeam(current.id, team, { shared: request.shared });
    const settled = findWorkspaceByRef(deck.getSnapshot().workspaces, request.workspace);
    if (!settled || !findTeam(settled, team.id)) {
      log.error(
        "web:orchestrator",
        `${team.id} (${name}): the deck refused the team at ${wantedKey || "?"} — not made`,
      );
      return { kind: "held", why: "refused" };
    }
    if (wanted.kind === "provisioning") provisionTeams(current, [team]);
    return { kind: "created", teamId: team.id };
  }

  /**
   * The team a pane asking for `wanted` lands on in `current`: the one
   * holding that directory, or one minted for it — or the refusal.
   *
   * A pane JOINS rather than shares: a request naming a directory a team in
   * this workspace works in lands on that team. Sharing a directory is a
   * decision about TEAMS, taken at the "+ Team" door where the person can be
   * asked; a pane arriving with a bare path has nobody to ask, so it takes
   * the team that is there — the first of them, should several share the
   * directory. A directory a team in another workspace holds is refused: a
   * team never spans workspaces, so there is nothing here to join. The root
   * is the exception, held by every workspace opened on the same repository.
   * A directory nobody is in gets a team of its own, named after the pane
   * when the person named it and "Team N" otherwise.
   *
   * A CREATE heading for a directory a team already holds is refused, not
   * joined: a worktree cannot be made where one is, and a fork's surgery
   * (filed under the fresh team's create) would never run on a team that
   * already has its directory. The dialogs offer attaching to an existing
   * directory as a choice of its own.
   */
  function resolveLanding(
    workspaces: readonly Workspace[],
    current: Workspace,
    pane: Pane,
    wanted: TeamLocation,
    /** The pane's own membership, when it is relocating: it does not count
     * toward its own team's cap. */
    except?: string,
    /** The name for a team minted here, when the caller named one. */
    teamName?: string,
  ): Landing {
    const wantedKey = normalizePath(teamHeldPath({ location: wanted }) ?? "");
    // A directory a confirmed close is still tearing down is nobody's to
    // land on, whatever the deck says: the team left the deck before the
    // `git worktree remove` that is coming for the directory.
    if (holdsPath(wantedKey)) return { refusal: "held", why: "removing" };
    const claim = claimDirectory(workspaces, current, wanted);
    let team: Team & { location: TeamLocation };
    let fresh = false;
    if (claim.kind === "held") {
      // A team never spans workspaces, so a team abroad is not a membership
      // this pane can take — there is nothing here to join.
      if (claim.ws.id !== current.id) return { refusal: "held", why: "abroad" };
      // A worktree cannot be MADE where a team already is. The other half of
      // that rule does not apply to a landing: a pane joins a team whose own
      // create is still out and waits for it, which is how "+ Team" then
      // "+ Member" has always worked.
      if (wanted.kind === "provisioning") {
        return { refusal: "held", why: claim.creating ? "creating" : "occupied" };
      }
      // A team a confirmed close holds is being ended: a pane landing on it
      // now would be reaped by that close a moment later.
      if (closing({ id: current.id, instance: current.instance }, claim.team.id)) {
        return { refusal: "held", why: "ending" };
      }
      const location = claim.team.location;
      if (!location) return { refusal: "held", why: "refused" };
      team = { ...claim.team, location };
    } else {
      const seq = nextTeamSeq(workspaces);
      const asked = (teamName ?? pane.name)?.trim();
      const name = asked && !teamNameTaken(current, asked) ? asked : autoTeamName(seq);
      team = { id: teamId(seq), name, location: wanted };
      fresh = true;
    }
    const members = membersOf(current, team.id).filter((member) => member.id !== except);
    if (members.length >= MAX_PANES) return { refusal: "full" };
    return { team, fresh };
  }

  /** The team a pane asked to JOIN by id — whatever its placement, a
   * create still out included — or the refusal: a team that is not here or
   * holds no directory is nothing to join (`held`), one a close holds is
   * being ended, and one at the cap is full. */
  function resolveJoin(current: Workspace, teamId: string, except?: string): Landing {
    const team = teamsOf(current).find((candidate) => candidate.id === teamId);
    if (!team?.location) return { refusal: "held", why: "refused" };
    if (closing({ id: current.id, instance: current.instance }, team.id)) {
      return { refusal: "held", why: "ending" };
    }
    const members = membersOf(current, team.id).filter((member) => member.id !== except);
    if (members.length >= MAX_PANES) return { refusal: "full" };
    return { team: { ...team, location: team.location }, fresh: false };
  }

  /** Where a request lands: the team it named, else the team of the
   * directory it asked for (the root when it asked for none). */
  function resolveRequest(
    workspaces: readonly Workspace[],
    current: Workspace,
    request: Pick<CreatePaneRequest, "pane" | "placement" | "team" | "teamName">,
  ): Landing {
    return request.team !== undefined
      ? resolveJoin(current, request.team)
      : resolveLanding(
          workspaces,
          current,
          request.pane,
          request.placement ?? rootOf(current),
          undefined,
          request.teamName,
        );
  }

  /** Put `pane` on the landing's team: the team minted when fresh, the
   * membership written under a role the dialog would suggest, and a fresh
   * team's create issued — only once the deck confirms the pane is ON the
   * team. The transforms refuse silently and answer the same array, so the
   * deck is read back rather than trusted: a create issued for a team the
   * deck refused would make a worktree nobody could ever name. Answers
   * whether the pane landed on the team. */
  function join(
    current: Workspace,
    pane: Pane,
    landing: { team: Team & { location: TeamLocation }; fresh: boolean },
    postProvision: CreatePaneRequest["postProvision"],
    /** The role the caller had in mind; taken when free on the team. */
    asked?: string,
  ): boolean {
    const { team, fresh } = landing;
    const wanted = asked?.trim();
    const role =
      wanted && !roleTaken(current, team.id, wanted)
        ? wanted
        : suggestRoleAddress(
            membersOf(current, team.id).flatMap((member) =>
              member.team ? [member.team.role] : [],
            ),
          );
    if (fresh) actions.createTeam(current.id, team);
    actions.joinTeam(current.id, pane.id, team.id, role);
    const settled = findWorkspaceByRef(deck.getSnapshot().workspaces, {
      id: current.id,
      instance: current.instance,
    });
    const member = settled?.panes.find((candidate) => candidate.id === pane.id);
    if (!settled || !member || teamOfPane(settled, member)?.id !== team.id) {
      log.error(
        "web:orchestrator",
        `${pane.id}: the deck refused team ${team.id} (${team.name}) at ${teamHeldPath(team) ?? "?"} — not landed`,
      );
      return false;
    }
    if (fresh && team.location.kind === "provisioning") {
      // The step rides the request and is filed under the team the landing
      // just minted — the only id that could not have been known before.
      if (postProvision) worktrees.registerPostProvision(team.id, postProvision);
      provisionTeams(current, [team]);
    }
    return true;
  }

  function roomFor(
    workspace: WorkspaceRef,
    pane: Pane,
    placement: TeamLocation,
  ): CreatePaneOutcome | null {
    const workspaces = deck.getSnapshot().workspaces;
    const current = findWorkspaceByRef(workspaces, workspace);
    if (!current) return { kind: "gone" };
    const landing = resolveLanding(workspaces, current, pane, placement);
    return "refusal" in landing ? refusalOutcome(landing) : null;
  }

  /**
   * Land a pane on the team it named, or on the team that holds the
   * directory it asked for — minting that team when nobody holds it yet.
   * The pane itself lands without a placement of its own: from here on its
   * directory is a question about its team. A request naming neither lands
   * in the workspace root.
   */
  function landPane(request: CreatePaneRequest): CreatePaneOutcome {
    const { workspace, pane, postProvision } = request;
    const workspaces = deck.getSnapshot().workspaces;
    const current = findWorkspaceByRef(workspaces, workspace);
    if (!current) return refuse(pane.id, { kind: "gone" });
    const landing = resolveRequest(workspaces, current, request);
    if ("refusal" in landing) return refuse(pane.id, refusalOutcome(landing));
    actions.addAgentPane(current.id, pane);
    if (!join(current, pane, landing, postProvision, request.role)) {
      // Never a pane on no team reported as created: the pane goes back
      // out, and the caller hears a refusal.
      actions.closeAgent(current.id, pane.id);
      return refuse(pane.id, { kind: "held", why: "refused" });
    }
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
    if ("refusal" in landing) return refusalOutcome(landing);
    // Already there: nothing to move.
    if (teamOfPane(current, pane)?.id === landing.team.id) {
      return { kind: "created", teamId: landing.team.id };
    }
    // A pane holds ONE team: joining the new one is leaving the old one,
    // and a roster the old membership alone kept alive is pruned with it.
    if (!join(current, pane, landing, undefined)) return { kind: "held", why: "refused" };
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
        throw new Error(placementRefusalMessage(outcome.why));
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

  /** Re-issue a team's FAILED create: the error clears (the card goes back
   * to creating) and the same intent goes out again under the workspace's
   * name as it is now. A card that is still creating has nothing to retry
   * — a second click before the first answers is one create, not two — and
   * a team a confirmed close holds is being ended, not retried. */
  const retryProvisioning: AgentOrchestrator["retryProvisioning"] = (wsId, teamId) => {
    const workspace = findWorkspace(deck.getSnapshot().workspaces, wsId);
    const team = workspace ? teamsOf(workspace).find((candidate) => candidate.id === teamId) : undefined;
    if (!workspace || !team || team.location?.kind !== "provisioning") return;
    if (team.location.error === undefined) return;
    if (closing({ id: workspace.id, instance: workspace.instance }, teamId)) return;
    actions.setTeamProvisioningError(wsId, teamId, null);
    provisionTeams(workspace, [team]);
  };

  return {
    landPane,
    createTeam,
    roomFor,
    relocatePane,
    landOrThrow,
    createWorkspace,
    retryProvisioning,
  };
}
