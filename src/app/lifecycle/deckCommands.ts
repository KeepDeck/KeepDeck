/**
 * The deck's owner for the lifecycle machine's commands. Each command is
 * one change to the deck, made through the deck's own actions, and its
 * answer names the deck revision the change landed at: the machine holds it
 * durable once a save reaches that revision. A command whose change is
 * already there — asked again after a restart — answers unchanged.
 *
 * A new pane is admitted in the same step it is written: its role by the
 * one role rule, the conversation it resumes by the one claim rule. A
 * refusal is answered in that rule's words, and nothing of the pane is
 * written. A new team lands with its first members whole or not at all.
 */
import {
  findTeam,
  findWorkspace,
  membersOf,
  nextAutoTeamName,
  sessionClaimant,
  type Pane,
  type TeamLocation,
  type Workspace,
} from "../../domain/deck";
import { paneDraftOf, teamDraftOf, workspaceDraftOf, type PaneDraft } from "../../domain/lifecycle";
import { admitRole, carryRole, roleRefusalMessage } from "../../domain/mail";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { Cmd } from "../../ipc/generated/lifecycle/Cmd";
import type { Outcome } from "../../ipc/generated/lifecycle/Outcome";
import type { TeamPlace } from "../../ipc/generated/lifecycle/TeamPlace";
import { sessionHeldText } from "../../presentation/resumeWords";
import type { DeckActions } from "../deckActions";
import type { DeckStore } from "../deckStore";
import type { CommandOwner } from "../lifecycleSnapshot";

type Member = { pane: string; draft: PaneDraft };

export function createDeckCommands(store: DeckStore, actions: DeckActions): CommandOwner {
  const answer = (kind: "applied" | "unchanged"): Outcome => ({ kind, revision: store.revision() });
  const changed = (before: number): Outcome => answer(store.revision() === before ? "unchanged" : "applied");
  const rejected = (reason: string): Outcome => ({ kind: "rejected", reason });
  const workspace = (id: string): Workspace | undefined => findWorkspace(store.getSnapshot().workspaces, id);

  /** The role rule and the claim rule, asked together, against the deck as
   * it would be with `members` ahead of it on the team: why not, or null. */
  function admit(ws: Workspace, teamId: string, members: readonly Member[]): string | null {
    let roles = ws;
    for (const member of members) {
      const admitted = admitRole(roles, teamId, member.draft.role);
      if (!admitted.ok) return roleRefusalMessage(admitted.why, admitted.role, admitted.open);
      member.draft.role = admitted.role;
      const resumes = member.draft.session;
      if (resumes && sessionClaimant(store.getSnapshot().workspaces, { agent: member.draft.agentType, sessionId: resumes.id }, () => false)) {
        return sessionHeldText();
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
    if (!ws) return rejected("the workspace is gone");
    if (findTeam(ws, cmd.team)) return answer("unchanged");
    const team = teamDraftOf(cmd.draft);
    const members: Member[] = [];
    for (const member of cmd.members) {
      const draft = paneDraftOf(member.draft);
      if (!draft) return rejected("the new agent's draft could not be read");
      members.push({ pane: member.pane, draft });
    }
    if (!team) return rejected("the new team's draft could not be read");
    const before = store.revision();
    actions.createTeam(cmd.workspace, { id: cmd.team, name: team.name, location: locationOf(ws, cmd.place) });
    const created = workspace(cmd.workspace);
    const refusal = created && findTeam(created, cmd.team) ? admit(created, cmd.team, members) : "the deck took no such team";
    if (refusal !== null || !seat(cmd.workspace, cmd.team, members)) {
      actions.dissolveTeam(cmd.workspace, cmd.team);
      return rejected(refusal ?? "the deck took no such agent");
    }
    return changed(before);
  }

  function addPane(cmd: Extract<Cmd, { kind: "addPane" }>): Outcome {
    const ws = workspace(cmd.workspace);
    if (!ws) return rejected("the workspace is gone");
    if (ws.panes.some((pane) => pane.id === cmd.pane)) return answer("unchanged");
    if (!findTeam(ws, cmd.team)) return rejected("the team is gone");
    const draft = paneDraftOf(cmd.draft);
    if (!draft) return rejected("the new agent's draft could not be read");
    const member = { pane: cmd.pane, draft };
    const refusal = admit(ws, cmd.team, [member]);
    if (refusal !== null) return rejected(refusal);
    const before = store.revision();
    return seat(cmd.workspace, cmd.team, [member]) ? changed(before) : rejected("the deck took no such agent");
  }

  /** A member to the workspace's root team — the team made here under the
   * machine's id when there is none yet — carrying the role the person gave
   * it, its old conversation reset in the same step. */
  function movePane(cmd: Extract<Cmd, { kind: "movePane" }>): Outcome {
    const ws = workspace(cmd.workspace);
    const pane = ws?.panes.find((candidate) => candidate.id === cmd.pane);
    if (!ws || !pane) return rejected("the agent is gone");
    if (pane.team?.teamId === cmd.to) return answer("unchanged");
    const before = store.revision();
    const minted = cmd.newRoot && !findTeam(ws, cmd.to);
    if (minted) {
      actions.createTeam(cmd.workspace, { id: cmd.to, name: nextAutoTeamName(ws), location: { kind: "attached", cwd: ws.cwd } });
    }
    const current = workspace(cmd.workspace);
    const admitted = current && findTeam(current, cmd.to) ? carryRole(current, cmd.to, pane.team?.role, pane.id) : null;
    if (admitted?.ok) actions.joinTeam(cmd.workspace, cmd.pane, cmd.to, admitted.role);
    const moved = workspace(cmd.workspace)?.panes.find((candidate) => candidate.id === cmd.pane)?.team?.teamId === cmd.to;
    if (!moved) {
      if (minted) actions.dissolveTeam(cmd.workspace, cmd.to);
      return rejected(admitted && !admitted.ok ? roleRefusalMessage(admitted.why, admitted.role, admitted.open) : "the deck took no such move");
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
        if (!draft) return rejected("the new workspace's draft could not be read");
        return through(() => actions.createWorkspace({ id: cmd.workspace, instance: createWorkspaceInstance(), ...draft, panes: [] }));
      }
      case "addTeam":
        return addTeam(cmd);
      case "retryTeam":
        return through(() => actions.setTeamProvisioningError(cmd.workspace, cmd.team, null));
      case "settleTeam": {
        const branch = cmd.branch;
        if (branch === null) return rejected("a team's worktree settles on its branch");
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
        return through(() => actions.archiveWorkspace(cmd.workspace));
      case "clearArchived":
        return through(() => actions.restoreWorkspace(cmd.workspace));
      case "markSuspended":
        return through(() => actions.suspendPanes(cmd.workspace, [cmd.pane]));
      case "clearSuspended":
        return through(() => actions.requestPanesWake(cmd.workspace, [cmd.pane]));
      default:
        return rejected(`the deck carries no ${cmd.kind} command`);
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
