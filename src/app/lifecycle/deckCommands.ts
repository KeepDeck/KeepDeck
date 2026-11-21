/**
 * The deck's owner for the lifecycle machine's commands. Each command is
 * one change to the deck, made through the deck's own actions, and its
 * answer names the deck revision the change landed at: the machine holds it
 * durable once a save reaches that revision. A command whose change is
 * already there — asked again after a restart — answers unchanged.
 *
 * A new pane is admitted in the same step it is written: its role by the
 * one role rule, the conversation it resumes by the one claim rule. A
 * refusal is answered as that rule's kind — never words: the page says it —
 * and nothing of the pane is written. A new team lands with its first
 * members whole or not at all.
 */
import {
  findTeam,
  findWorkspace,
  membersOf,
  nextAutoTeamName,
  sessionClaimant,
  teamFull,
  type Pane,
  type TeamLocation,
  type Workspace,
} from "../../domain/deck";
import { paneDraftOf, roleRefused, teamDraftOf, workspaceDraftOf, type OwnerRefusal, type PaneDraft } from "../../domain/lifecycle";
import { admitRole, carryRole } from "../../domain/mail";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { Cmd } from "../../ipc/generated/lifecycle/Cmd";
import type { Outcome } from "../../ipc/generated/lifecycle/Outcome";
import type { TeamPlace } from "../../ipc/generated/lifecycle/TeamPlace";
import type { DeckActions } from "../deckActions";
import type { DeckStore } from "../deckStore";
import { ownerRefused, type CommandOwner } from "../lifecycleSnapshot";

type Member = { pane: string; draft: PaneDraft };

export function createDeckCommands(
  store: DeckStore,
  actions: DeckActions,
  /** Where the person keeps suspended agents: in the tray, or where they
   * stood. Read at each suspend. */
  placement: { suspendedToTray(): boolean } = { suspendedToTray: () => false },
): CommandOwner {
  const answer = (kind: "applied" | "unchanged"): Outcome => ({ kind, revision: store.revision() });
  const changed = (before: number): Outcome => answer(store.revision() === before ? "unchanged" : "applied");
  const rejected = ownerRefused;
  const workspace = (id: string): Workspace | undefined => findWorkspace(store.getSnapshot().workspaces, id);

  /** The role rule and the claim rule, asked together, against the deck as
   * it would be with `members` ahead of it on the team: why not, or null. */
  function admit(ws: Workspace, teamId: string, members: readonly Member[]): OwnerRefusal | null {
    let roles = ws;
    for (const member of members) {
      // The team's own cap, before the role is asked.
      if (teamFull(roles, teamId)) return { kind: "teamFull" };
      const admitted = admitRole(roles, teamId, member.draft.role);
      if (!admitted.ok) return roleRefused(admitted);
      member.draft.role = admitted.role;
      const resumes = member.draft.session;
      // Against the deck as it would be — the members ahead of this one
      // included, or two of them could take one conversation.
      const prospective = store.getSnapshot().workspaces.map((other) => (other.id === roles.id ? roles : other));
      if (resumes && sessionClaimant(prospective, { agent: member.draft.agentType, sessionId: resumes.id }, () => false)) {
        return { kind: "sessionHeld" };
      }
      roles = { ...roles, panes: [...roles.panes, paneOf(member, teamId)] };
    }
    return null;
  }

  function paneOf(member: Member, teamId: string): Pane {
    const { role, session, ...rest } = member.draft;
    return {
      id: member.pane,
      ...rest,
      team: { teamId, role },
      ...(session && { session: { id: session.id, boundAt: new Date().toISOString() } }),
    };
  }

  /** Write `members` onto the team; if the deck refuses any of them, take
   * back every one this call wrote. Whether all landed. */
  function seat(wsId: string, teamId: string, members: readonly Member[]): boolean {
    const written: string[] = [];
    for (const member of members) {
      actions.addAgentPane(wsId, paneOf(member, teamId));
      const landed = findWorkspace(store.getSnapshot().workspaces, wsId)?.panes.find((pane) => pane.id === member.pane);
      if (landed?.team?.teamId !== teamId) {
        for (const pane of [...written, member.pane]) actions.closeAgent(wsId, pane);
        return false;
      }
      written.push(member.pane);
    }
    return true;
  }

  function addTeam(cmd: Extract<Cmd, { kind: "addTeam" }>): Outcome {
    const ws = workspace(cmd.workspace);
    if (!ws) return rejected({ kind: "gone", what: "workspace" });
    const members: Member[] = [];
    for (const member of cmd.members) {
      const draft = paneDraftOf(member.draft);
      if (!draft) return rejected({ kind: "unreadable", what: "agent" });
      members.push({ pane: member.pane, draft });
    }
    if (findTeam(ws, cmd.team)) {
      // Asked again: the team is there. Unchanged only if its first members
      // are too — a deck that kept the team without some of them gets them
      // now, or the command would be settled with its members never seated.
      const missing = members.filter((member) => !ws.panes.some((pane) => pane.id === member.pane));
      if (missing.length === 0) return answer("unchanged");
      const refusal = admit(ws, cmd.team, missing);
      if (refusal !== null) return rejected(refusal);
      const before = store.revision();
      return seat(cmd.workspace, cmd.team, missing) ? changed(before) : rejected({ kind: "notTaken", what: "agent" });
    }
    const team = teamDraftOf(cmd.draft);
    if (!team) return rejected({ kind: "unreadable", what: "team" });
    const before = store.revision();
    actions.createTeam(cmd.workspace, { id: cmd.team, name: team.name, location: locationOf(ws, cmd.place) });
    const created = workspace(cmd.workspace);
    const refusal: OwnerRefusal | null =
      created && findTeam(created, cmd.team) ? admit(created, cmd.team, members) : { kind: "notTaken", what: "team" };
    if (refusal !== null || !seat(cmd.workspace, cmd.team, members)) {
      actions.dissolveTeam(cmd.workspace, cmd.team);
      return rejected(refusal ?? { kind: "notTaken", what: "agent" });
    }
    return changed(before);
  }

  function addPane(cmd: Extract<Cmd, { kind: "addPane" }>): Outcome {
    const ws = workspace(cmd.workspace);
    if (!ws) return rejected({ kind: "gone", what: "workspace" });
    if (ws.panes.some((pane) => pane.id === cmd.pane)) return answer("unchanged");
    if (!findTeam(ws, cmd.team)) return rejected({ kind: "gone", what: "team" });
    const draft = paneDraftOf(cmd.draft);
    if (!draft) return rejected({ kind: "unreadable", what: "agent" });
    const member = { pane: cmd.pane, draft };
    const refusal = admit(ws, cmd.team, [member]);
    if (refusal !== null) return rejected(refusal);
    const before = store.revision();
    return seat(cmd.workspace, cmd.team, [member]) ? changed(before) : rejected({ kind: "notTaken", what: "agent" });
  }

  /** A member to the workspace's root team — the team made here under the
   * machine's id when there is none yet — under the role the person picked
   * there, or carrying its own when they picked none; its old conversation
   * reset in the same step. */
  function movePane(cmd: Extract<Cmd, { kind: "movePane" }>): Outcome {
    const ws = workspace(cmd.workspace);
    const pane = ws?.panes.find((candidate) => candidate.id === cmd.pane);
    if (!ws || !pane) return rejected({ kind: "gone", what: "agent" });
    if (pane.team?.teamId === cmd.to) return answer("unchanged");
    const before = store.revision();
    const minted = cmd.newRoot && !findTeam(ws, cmd.to);
    if (minted) {
      actions.createTeam(cmd.workspace, { id: cmd.to, name: nextAutoTeamName(ws), location: { kind: "attached", cwd: ws.cwd } });
    }
    const current = workspace(cmd.workspace);
    if (current && findTeam(current, cmd.to) && teamFull(current, cmd.to)) {
      if (minted) actions.dissolveTeam(cmd.workspace, cmd.to);
      return rejected({ kind: "teamFull" });
    }
    const admitted =
      current && findTeam(current, cmd.to)
        ? cmd.role !== null
          ? admitRole(current, cmd.to, cmd.role, pane.id)
          : carryRole(current, cmd.to, pane.team?.role, pane.id)
        : null;
    if (admitted?.ok) actions.joinTeam(cmd.workspace, cmd.pane, cmd.to, admitted.role);
    const moved = workspace(cmd.workspace)?.panes.find((candidate) => candidate.id === cmd.pane)?.team?.teamId === cmd.to;
    if (!moved) {
      if (minted) actions.dissolveTeam(cmd.workspace, cmd.to);
      return rejected(admitted && !admitted.ok ? roleRefused(admitted) : { kind: "notTaken", what: "move" });
    }
    actions.resetPaneSession(cmd.workspace, cmd.pane);
    return changed(before);
  }

  function removeTeam(wsId: string, teamId: string): Outcome {
    const ws = workspace(wsId);
    if (!ws || !findTeam(ws, teamId)) return answer("unchanged");
    const before = store.revision();
    for (const member of membersOf(ws, teamId)) actions.closeAgent(wsId, member.id);
    actions.dissolveTeam(wsId, teamId);
    return changed(before);
  }

  /** One change through `act`, answered by whether the deck moved. */
  function through(act: () => void): Outcome {
    const before = store.revision();
    act();
    return changed(before);
  }

  function carry(cmd: Cmd): Outcome {
    switch (cmd.kind) {
      case "addWorkspace": {
        if (workspace(cmd.workspace)) return answer("unchanged");
        const draft = workspaceDraftOf(cmd.draft);
        if (!draft) return rejected({ kind: "unreadable", what: "workspace" });
        return through(() => actions.createWorkspace({ id: cmd.workspace, instance: createWorkspaceInstance(), ...draft, panes: [] }));
      }
      case "addTeam":
        return addTeam(cmd);
      case "retryTeam":
        return through(() => actions.setTeamProvisioningError(cmd.workspace, cmd.team, null));
      case "settleTeam": {
        const branch = cmd.branch;
        if (branch === null) return rejected({ kind: "noBranch" });
        return through(() => actions.resolveTeamProvisioning(cmd.workspace, cmd.team, { cwd: cmd.cwd, branch }));
      }
      case "failTeam":
        return through(() => actions.setTeamProvisioningError(cmd.workspace, cmd.team, cmd.reason));
      case "addPane":
        return addPane(cmd);
      case "movePane":
        return movePane(cmd);
      case "removePane":
        if (!workspace(cmd.workspace)?.panes.some((pane) => pane.id === cmd.pane)) return answer("unchanged");
        return through(() => actions.closeAgent(cmd.workspace, cmd.pane));
      case "removeTeam":
        return removeTeam(cmd.workspace, cmd.team);
      case "removeWorkspace":
        if (!workspace(cmd.workspace)) return answer("unchanged");
        return through(() => actions.closeWorkspace(cmd.workspace));
      case "markArchived":
        return through(() => actions.archiveWorkspace(cmd.workspace, cmd.panes));
      case "settleArchive":
        // Put away, no longer being put away. What the machine could not do
        // stays owed in its journal, and is said by its notices: nothing of
        // it rides on the marker.
        return through(() => actions.settleArchive(cmd.workspace, { reaps: [], disarm: false }));
      case "clearArchived":
        return through(() => actions.restoreWorkspace(cmd.workspace));
      case "markSuspended":
        // The marker first; the tray entry only ever follows a marker that
        // landed.
        return through(() => {
          actions.suspendPanes(cmd.workspace, [cmd.pane]);
          if (placement.suspendedToTray()) actions.moveSuspendedToTray(cmd.workspace, cmd.pane);
        });
      case "clearSuspended":
        return through(() => actions.requestPanesWake(cmd.workspace, [cmd.pane]));
      default:
        return rejected({ kind: "wrongOwner", command: cmd.kind });
    }
  }

  return { carry: (due) => Promise.resolve(carry(due.cmd)) };
}

/** Where a new team runs, as the deck draws it. A worktree still being made
 * carries the machine's own ticket, its branch named by the machine — the
 * intent's `index` fed only the page's own branch naming, which a named
 * branch never reaches. */
function locationOf(ws: Workspace, place: TeamPlace): TeamLocation {
  if (place.kind === "attached") return { kind: "attached", cwd: place.cwd, ...(place.branch !== null && { branch: place.branch }) };
  return {
    kind: "provisioning",
    intent: { repo: ws.cwd, path: place.path, branch: place.branch, ...(place.base !== null && { base: place.base }), index: 0 },
  };
}
