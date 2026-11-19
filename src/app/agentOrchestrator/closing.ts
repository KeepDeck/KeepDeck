import {
  directoriesStillHeld,
  findWorkspaceByRef,
  membersOf,
  normalizePath,
  paneSuspendBlock,
  teamHeldPath,
  teamSuspendCohort,
  teamsOf,
  type Pane,
  type Team,
  type Workspace,
  type WorktreeTarget,
  type WorktreeTeardownFailure,
} from "../../domain/deck";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import { log } from "../../ipc/log";
import type {
  AgentOrchestrator,
  SessionRegistryPort,
  SuspendPolicyPort,
  PaneLifecyclePort,
  WorktreeTeardown,
} from ".";
import type { DeckActions } from "../deckActions";
import type { DeckStore } from "../deckStore";
import { deletableWorktrees } from "../closing/teardownTargets";
import { dropPaneSpawnSpec } from "../spawnSpecs";
import type { CreatedWorktree, WorktreeProvisioner } from "../worktrees";

/** End a pane's process and what this run keeps for it — its cached plan,
 * its lifecycle (usage, the binding watch). The tail a suspend and an
 * archive share; the marker that keeps the pane down is each caller's. */
export async function endPaneProcess(
  ports: { sessions: SessionRegistryPort; lifecycle: PaneLifecyclePort },
  paneId: string,
): Promise<void> {
  dropPaneSpawnSpec(paneId);
  ports.lifecycle.retire(paneId);
  await ports.sessions.close(paneId);
}

interface ClosingDeps {
  deck: DeckStore;
  actions: DeckActions;
  sessions: SessionRegistryPort;
  suspendPolicy: SuspendPolicyPort;
  worktrees: WorktreeProvisioner;
  /** Whether a pane's directory is gone — a suspend has nothing to come back
   * to. The question, not the map it is answered from. */
  isBlocked(paneId: string): boolean;
  lifecycle: PaneLifecyclePort;
  /** Forget what the backend keeps PER WORKSPACE when the workspace closes
   * — one forgetter per keeper: the artifact store, the MCP library scope.
   * The live workspace set is deck-model knowledge Rust cannot derive;
   * without these a deleted workspace's data accumulates forever, and a
   * reused workspace id would inherit it. Each runs whatever the others did,
   * and a failure only logs: the deck teardown must not abort on a store
   * hiccup. Optional so non-app tests need not stub it. */
  workspaceForgetters?: readonly WorkspaceForgetter[];
  /** Whether an archive is stopping this workspace's agents right now — a
   * close waits for it to finish rather than racing it. */
  archiving?: (workspace: WorkspaceRef) => boolean;
}

export type WorkspaceForgetter = (wsId: string) => Promise<void>;

export interface AgentOrchestratorClosing {
  suspend: AgentOrchestrator["suspend"];
  suspendTeam: AgentOrchestrator["suspendTeam"];
  close: AgentOrchestrator["close"];
  /** Whether a confirmed disband or workspace close holds `teamId` — from
   * the confirmation until the team is out of the deck. The create runner
   * asks this after every await: a worktree landing for a captured team is
   * the close's to remove, so nothing past the create runs on the team's
   * behalf and nothing resolves its card. The landing asks it too: a pane
   * cannot join a team that is being ended. */
  closing(workspace: WorkspaceRef, teamId: string): boolean;
  /** Whether a confirmed close still holds `path` — from the capture of the
   * team that ran there (or whose create was heading there) until the
   * teardown has finished with the directory: the sessions reaped and, when
   * the box was ticked, the worktree removed. The team leaves the deck
   * BEFORE that, so the deck alone would show the directory as free while a
   * `git worktree remove` is still coming for it. */
  holdsPath(path: string): boolean;
  /** Whether a confirmed close of the whole workspace is under way — an
   * archive is refused meanwhile. */
  closingWorkspace(workspace: WorkspaceRef): boolean;
}

/** One key per {workspace INSTANCE, team}: a capture belongs to one run's
 * hold on a workspace, never to anything that holds its id later. */
function captureKey(workspace: WorkspaceRef, teamId: string): string {
  return `${workspace.id}#${workspace.instance}/${teamId}`;
}

/** A team taken for closing: what its create put on disk, once the ticket
 * settles, and the members retired at the taking. */
interface Capture {
  team: Team;
  members: Pane[];
  created: Promise<CreatedWorktree | null>;
}

export function createAgentOrchestratorClosing({
  deck,
  actions,
  sessions,
  suspendPolicy,
  worktrees,
  isBlocked,
  lifecycle,
  workspaceForgetters = [],
  archiving = () => false,
}: ClosingDeps): AgentOrchestratorClosing {
  const suspending = new Set<string>();
  /**
   * The teams a confirmed close holds, by [`captureKey`] — the ONE
   * coordinator for a disband and a workspace close, which is what lets
   * the two race safely: whoever takes a team first does everything for
   * it (the step cleared, the ticket awaited, the members reaped, the
   * worktree removed ONCE), and the second taker does nothing at all. A
   * key is held until the team is out of the deck.
   */
  const captured = new Set<string>();
  /** Workspaces a confirmed close holds, by `id#instance` — a second
   * confirmation of the same close, or a member close inside it, backs off. */
  const closingWorkspaces = new Set<string>();
  /**
   * Directories a confirmed close is still finishing with, by normalized
   * path, with how many closes hold each: a team's directory (or the one
   * its create was heading for) from its capture, and what the ticket says
   * the create made, until the teardown is done. The deck loses the team
   * before the directory is gone from disk; this is what keeps a landing
   * off the directory in between.
   */
  const heldPaths = new Map<string, number>();

  function holdPath(path: string | undefined, root: string): void {
    if (path === undefined) return;
    const key = normalizePath(path);
    // The root is never torn down, and every workspace on the repository
    // holds it for itself.
    if (key === normalizePath(root)) return;
    heldPaths.set(key, (heldPaths.get(key) ?? 0) + 1);
  }

  function letGoPaths(paths: readonly string[], root: string): void {
    for (const path of paths) {
      const key = normalizePath(path);
      if (key === normalizePath(root)) continue;
      const count = heldPaths.get(key) ?? 0;
      if (count <= 1) heldPaths.delete(key);
      else heldPaths.set(key, count - 1);
    }
  }

  const workspaceKey = (workspace: WorkspaceRef) => `${workspace.id}#${workspace.instance}`;

  const live = (workspace: WorkspaceRef): Workspace | undefined =>
    findWorkspaceByRef(deck.getSnapshot().workspaces, workspace);

  /** Retire a pane's per-process state: its cached plan, its usage and
   * binding. Once per pane, whichever close reaches it first. */
  const retired = new Set<string>();
  function retire(paneId: string): void {
    if (retired.has(paneId)) return;
    retired.add(paneId);
    dropPaneSpawnSpec(paneId);
    lifecycle.retire(paneId);
  }

  /**
   * Take a team for closing. The first taker owns it: from this line the
   * team's fork step is forgotten, its members are retired, and the ticket
   * its create took out is this capture's to wait on — a create that is
   * mid-`git worktree add` publishes what it made to nobody else. A second
   * taker gets null: the owner does the removing, and it does nothing.
   */
  function capture(workspace: WorkspaceRef, team: Team, members: Pane[]): Capture | null {
    const key = captureKey(workspace, team.id);
    if (captured.has(key)) return null;
    captured.add(key);
    worktrees.clearPostProvision(team.id);
    for (const member of members) retire(member.id);
    return { team, members, created: worktrees.awaitCreated(team.id) };
  }

  function release(workspace: WorkspaceRef, teamId: string): void {
    captured.delete(captureKey(workspace, teamId));
  }

  /**
   * What a disband deletes when the box was ticked: the dialog's frozen
   * list (it carries the observed branch per worktree), the team's LIVE
   * directory (a create that landed while the dialog was open is one the
   * frozen list never saw), and what the ticket says the create made — one
   * entry per directory. Never the workspace root: a team there disbands
   * without deleting, structurally, whatever any list says.
   */
  /** The teams other in-flight closes have taken in this workspace: they are
   * leaving too, so they keep no directory alive for this one. */
  function alsoLeaving(workspace: Workspace | undefined): string[] {
    if (!workspace) return [];
    const ref = { id: workspace.id, instance: workspace.instance };
    return teamsOf(workspace)
      .filter((team) => captured.has(captureKey(ref, team.id)))
      .map((team) => team.id);
  }

  function doomedFor(
    workspace: Workspace | undefined,
    root: string,
    teamIds: readonly string[],
    frozen: readonly WorktreeTarget[],
    created: readonly (CreatedWorktree | null)[],
  ): WorktreeTarget[] {
    return deletableWorktrees({
      workspaces: deck.getSnapshot().workspaces,
      workspace,
      root,
      ending: teamIds,
      alsoLeaving: alsoLeaving(workspace),
      frozen,
      created,
    });
  }

  /** Whether a team that OUTLIVES this close still works in `path` — the one
   * reason its directory is not this close's to freeze. */
  function sparedFor(workspace: Workspace, ending: readonly string[], path: string): boolean {
    return directoriesStillHeld(deck.getSnapshot().workspaces, workspace.id, [
      ...ending,
      ...alsoLeaving(live({ id: workspace.id, instance: workspace.instance })),
    ]).has(normalizePath(path));
  }

  /** The tail a single Suspend and a team's share, for panes already judged:
   * held against any other suspend for as long as it runs; the marker for all
   * of them in one change; then — by the placement setting — the tray (a tray
   * entry only ever follows a marker that landed); then each process ended. */
  async function stopPanes(wsId: string, paneIds: readonly string[]): Promise<void> {
    for (const paneId of paneIds) suspending.add(paneId);
    try {
      actions.suspendPanes(wsId, paneIds);
      if (suspendPolicy.moveToTray()) {
        for (const paneId of paneIds) actions.moveSuspendedToTray(wsId, paneId);
      }
      await Promise.all(paneIds.map((paneId) => endPaneProcess({ sessions, lifecycle }, paneId)));
    } finally {
      for (const paneId of paneIds) suspending.delete(paneId);
    }
  }

  const suspend: AgentOrchestrator["suspend"] = async (wsId, paneId) => {
    if (suspending.has(paneId)) return "in-flight";
    const workspace = deck.getSnapshot().workspaces.find((candidate) => candidate.id === wsId);
    const pane = workspace?.panes.find((candidate) => candidate.id === paneId);
    if (!workspace || !pane) return "gone";
    const refusal = paneSuspendBlock(workspace, pane, isBlocked(paneId));
    if (refusal) return refusal;
    log.info("web:orchestrator", `${paneId}: suspending`);
    await stopPanes(wsId, [paneId]);
    return "suspended";
  };

  const suspendTeam: AgentOrchestrator["suspendTeam"] = async (wsId, teamId, shown) => {
    const workspace = deck.getSnapshot().workspaces.find((candidate) => candidate.id === wsId);
    if (!workspace) return [];
    // Judged again now, against the live deck: the confirm stood open for a
    // while. Only members the person was SHOWN — one that became stoppable
    // since never joins silently — and none another suspend is already
    // stopping.
    const taken = teamSuspendCohort(workspace, teamId, { blocked: isBlocked }).take.filter(
      (paneId) => shown.includes(paneId) && !suspending.has(paneId),
    );
    if (taken.length === 0) return [];
    log.info("web:orchestrator", `${teamId}: suspending ${taken.length} member(s)`);
    await stopPanes(wsId, taken);
    return taken;
  };

  /** End ONE agent. Its place on its team goes with the pane; the team
   * stays, with one member fewer — an empty one keeps its directory and
   * its card. A member of a team already taken by a disband or a workspace
   * close is that close's to end: ending it here too would reap its
   * session twice. */
  async function closeMember(workspace: Workspace, ref: WorkspaceRef, paneId: string): Promise<WorktreeTeardownFailure[]> {
    const pane = workspace.panes.find((candidate) => candidate.id === paneId);
    if (!pane) return [];
    if (closingWorkspaces.has(workspaceKey(ref))) return [];
    if (pane.team && captured.has(captureKey(ref, pane.team.teamId))) return [];
    retire(paneId);
    actions.closeAgent(workspace.id, paneId);
    await Promise.allSettled([sessions.close(paneId)]);
    retired.delete(paneId);
    return [];
  }

  /** Disband ONE team: the capture, then — once its ticket settles — the
   * members and the team out of the deck, the sessions reaped, and the
   * worktree removed once when the box was ticked. The team's directory is
   * held against a landing until the teardown is done with it. */
  async function disband(
    workspace: Workspace,
    ref: WorkspaceRef,
    teamId: string,
    teardown: WorktreeTeardown,
  ): Promise<WorktreeTeardownFailure[]> {
    const team = teamsOf(workspace).find((candidate) => candidate.id === teamId);
    if (!team) return [];
    const taken = capture(ref, team, membersOf(workspace, team.id));
    if (!taken) return [];
    const held: string[] = [];
    // A directory a team that OUTLIVES this close still works in is not this
    // close's to freeze: `doomedFor` will spare it, so holding it only shuts
    // the live team's directory to landings and creates — with a "being
    // created or removed" message, while nothing is being removed.
    const hold = (path: string | undefined) => {
      if (path === undefined || sparedFor(workspace, [team.id], path)) return;
      holdPath(path, workspace.cwd);
      held.push(path);
    };
    hold(teamHeldPath(team));
    try {
      const created = await taken.created;
      hold(created?.path);
      const now = live(ref);
      // Read live: a member that joined while the ticket was out is on the
      // team the deck is about to lose, and its session goes with the rest.
      const members = now ? membersOf(now, team.id) : taken.members;
      for (const member of members) retire(member.id);
      const doomed = teardown.deleteWorktrees
        ? doomedFor(now, workspace.cwd, [team.id], teardown.worktrees, [created])
        : [];
      for (const target of doomed) hold(target.path);
      if (now) {
        for (const member of members) actions.closeAgent(now.id, member.id);
        actions.dissolveTeam(now.id, team.id);
      }
      release(ref, team.id);
      await Promise.allSettled(members.map((member) => sessions.close(member.id)));
      for (const member of members) retired.delete(member.id);
      return doomed.length === 0 ? [] : await worktrees.remove(doomed);
    } finally {
      release(ref, team.id);
      letGoPaths(held, workspace.cwd);
    }
  }

  /**
   * Close a whole workspace: every team captured FIRST, before a single
   * target is computed, so a disband confirmed a moment later loses its
   * capture and removes nothing — and, mirrored, a team a disband took
   * first is left to that disband: its worktree is not this close's to
   * delete, whatever the box said.
   */
  async function closeWhole(
    workspace: Workspace,
    ref: WorkspaceRef,
    teardown: WorktreeTeardown,
  ): Promise<WorktreeTeardownFailure[]> {
    const key = workspaceKey(ref);
    if (closingWorkspaces.has(key)) return [];
    closingWorkspaces.add(key);
    const teams = teamsOf(workspace);
    const captures = teams.flatMap((team) => {
      const taken = capture(ref, team, membersOf(workspace, team.id));
      return taken ? [taken] : [];
    });
    const held: string[] = [];
    const ending = captures.map((taken) => taken.team.id);
    // Same rule as a disband: a directory another workspace's team still
    // works in outlives this close, so it is not frozen by it.
    const hold = (path: string | undefined) => {
      if (path === undefined || sparedFor(workspace, ending, path)) return;
      holdPath(path, workspace.cwd);
      held.push(path);
    };
    for (const taken of captures) hold(teamHeldPath(taken.team));
    try {
      const lost = new Set(
        teams
          .filter((team) => !captures.some((taken) => taken.team.id === team.id))
          .flatMap((team) => {
            const held = teamHeldPath(team);
            return held === undefined ? [] : [normalizePath(held)];
          }),
      );
      // Panes on no team (a deck from before teams had to hold every pane):
      // no ticket to wait on, the same reaping.
      const loose = workspace.panes.filter((pane) => !pane.team);
      for (const pane of loose) retire(pane.id);

      const created = await Promise.all(captures.map((taken) => taken.created));
      for (const made of created) hold(made?.path);
      const now = live(ref);
      const ending = [
        ...loose,
        ...captures.flatMap((taken) =>
          now ? membersOf(now, taken.team.id) : taken.members,
        ),
      ];
      for (const pane of ending) retire(pane.id);
      const doomed = teardown.deleteWorktrees
        ? doomedFor(
            now,
            workspace.cwd,
            captures.map((taken) => taken.team.id),
            teardown.worktrees.filter((target) => !lost.has(normalizePath(target.path))),
            created,
          )
        : [];
      for (const target of doomed) hold(target.path);

      if (now) {
        actions.closeWorkspace(now.id);
        const forgotten = await Promise.allSettled(
          workspaceForgetters.map((forget) => forget(now.id)),
        );
        for (const outcome of forgotten) {
          if (outcome.status === "rejected") {
            log.warn(
              "web:orchestrator",
              `forgetting ${now.id}'s per-workspace data failed: ${outcome.reason}`,
            );
          }
        }
      }
      for (const taken of captures) release(ref, taken.team.id);
      closingWorkspaces.delete(key);
      await Promise.allSettled(ending.map((pane) => sessions.close(pane.id)));
      for (const pane of ending) retired.delete(pane.id);
      return doomed.length === 0 ? [] : await worktrees.remove(doomed);
    } finally {
      for (const taken of captures) release(ref, taken.team.id);
      closingWorkspaces.delete(key);
      letGoPaths(held, workspace.cwd);
    }
  }

  const close: AgentOrchestrator["close"] = async (request) => {
    // A confirmation that outlived its workspace — the slot may hold a new
    // one by now — touches nothing.
    const workspace = live(request.workspace);
    if (!workspace) return [];
    if (archiving(request.workspace)) {
      // Its agents are being stopped; ending them a second time underneath
      // is a race nobody asked for. The close is offered again once the
      // archive has settled.
      log.warn("web:orchestrator", `${workspace.id}: close refused — it is being archived`);
      return [];
    }
    switch (request.kind) {
      case "agent":
        return closeMember(workspace, request.workspace, request.paneId);
      case "team":
        return disband(workspace, request.workspace, request.teamId, request);
      case "workspace":
        return closeWhole(workspace, request.workspace, request);
    }
  };

  const closing: AgentOrchestratorClosing["closing"] = (workspace, teamId) =>
    captured.has(captureKey(workspace, teamId)) ||
    closingWorkspaces.has(workspaceKey(workspace));

  const holdsPath: AgentOrchestratorClosing["holdsPath"] = (path) =>
    heldPaths.has(normalizePath(path));

  const closingWorkspace: AgentOrchestratorClosing["closingWorkspace"] = (workspace) =>
    closingWorkspaces.has(workspaceKey(workspace));

  return { suspend, suspendTeam, close, closing, holdsPath, closingWorkspace };
}
